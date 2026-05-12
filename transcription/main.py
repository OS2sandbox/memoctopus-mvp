import os
import tempfile
import subprocess
import asyncio
from contextlib import asynccontextmanager
from typing import Optional

# torchaudio removed `set_audio_backend` in 2.1. Older pyannote.audio releases
# still call it at import time, which breaks diarization loading. Shim as a
# no-op before any pyannote import so diarization keeps working regardless of
# which minor version gets resolved at install time.
try:
    import torchaudio

    if not hasattr(torchaudio, "set_audio_backend"):
        torchaudio.set_audio_backend = lambda *args, **kwargs: None
except Exception as e:
    print(f"Note: torchaudio shim skipped ({e}).")

import httpx
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse

diarization_pipeline = None
vad_model = None
vllm_client: Optional[httpx.AsyncClient] = None

VLLM_ASR_BASE_URL = os.environ.get("VLLM_ASR_BASE_URL", "http://vllm-asr:8000/v1").rstrip("/")
HVISKE_MODEL = os.environ.get("HVISKE_MODEL", "syvai/hviske-v5.1")

# hviske-v5.1 has an effective audio ceiling of 31 s. Cap chunks under that with
# margin to absorb VAD boundary jitter.
VAD_MAX_CHUNK_S = float(os.environ.get("VAD_MAX_CHUNK_S", "28.0"))
VAD_MIN_SILENCE_MS = int(os.environ.get("VAD_MIN_SILENCE_MS", "300"))
VAD_MIN_SPEECH_MS = int(os.environ.get("VAD_MIN_SPEECH_MS", "250"))
ASR_CONCURRENCY = int(os.environ.get("ASR_CONCURRENCY", "4"))
VLLM_REQUEST_TIMEOUT_S = float(os.environ.get("VLLM_REQUEST_TIMEOUT_S", "300"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    global diarization_pipeline, vad_model, vllm_client

    print(f"Loading silero-vad...")
    from silero_vad import load_silero_vad

    vad_model = load_silero_vad()
    print("Silero VAD loaded.")

    vllm_client = httpx.AsyncClient(
        base_url=VLLM_ASR_BASE_URL,
        timeout=httpx.Timeout(VLLM_REQUEST_TIMEOUT_S),
    )
    print(f"vLLM ASR client targeting {VLLM_ASR_BASE_URL} (model={HVISKE_MODEL}).")

    hf_token = os.environ.get("HF_TOKEN", "").strip()
    if hf_token:
        try:
            from pyannote.audio import Pipeline

            print("Loading pyannote speaker diarization pipeline...")
            diarization_pipeline = Pipeline.from_pretrained(
                "pyannote/speaker-diarization-community-1",
                token=hf_token,
            )

            import torch

            if torch.cuda.is_available():
                diarization_pipeline.to(torch.device("cuda"))

            print("Pyannote diarization pipeline loaded successfully.")
        except Exception as e:
            print(f"Warning: Failed to load pyannote diarization pipeline: {e}")
            print("Speaker diarization will be unavailable.")
            diarization_pipeline = None
    else:
        print("HF_TOKEN not set — speaker diarization disabled.")

    try:
        yield
    finally:
        if vllm_client is not None:
            await vllm_client.aclose()


app = FastAPI(lifespan=lifespan)


def convert_to_wav(input_path: str, output_path: str):
    """Convert audio to 16kHz mono WAV using ffmpeg.

    Raises ValueError if ffmpeg fails or produces an empty file (#62).
    """
    result = subprocess.run(
        [
            "ffmpeg",
            "-i",
            input_path,
            "-ar",
            "16000",
            "-ac",
            "1",
            "-f",
            "wav",
            output_path,
            "-y",
        ],
        capture_output=True,
    )

    if result.returncode != 0:
        stderr = result.stderr.decode(errors="replace")[:500]
        raise ValueError(f"ffmpeg conversion failed: {stderr}")

    file_size = os.path.getsize(output_path)
    if file_size <= 44:
        raise ValueError(
            f"ffmpeg produced an empty audio file ({file_size} bytes). "
            "The input may be silent, corrupted, or in an unsupported format."
        )


def _probe_duration(wav_path: str) -> float:
    import soundfile as sf

    info = sf.info(wav_path)
    return float(info.frames) / float(info.samplerate)


def _vad_segments(wav_path: str) -> list[tuple[float, float]]:
    """Run silero-vad on a 16 kHz mono WAV. Return non-overlapping
    (start_s, end_s) tuples, each <= VAD_MAX_CHUNK_S."""
    import numpy as np
    import soundfile as sf
    import torch
    from silero_vad import get_speech_timestamps

    audio, sr = sf.read(wav_path, dtype="float32", always_2d=False)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sr != 16000:
        raise ValueError(f"VAD expects 16 kHz audio, got {sr} Hz")

    tensor = torch.from_numpy(np.ascontiguousarray(audio))
    raw = get_speech_timestamps(
        tensor,
        vad_model,
        sampling_rate=16000,
        min_silence_duration_ms=VAD_MIN_SILENCE_MS,
        min_speech_duration_ms=VAD_MIN_SPEECH_MS,
        return_seconds=True,
    )

    if not raw:
        # No speech detected; transcribe whole file as one chunk so the
        # caller still gets an attempt (and the empty-text guard downstream
        # surfaces a clean 422).
        return [(0.0, float(len(audio)) / 16000.0)]

    segments: list[tuple[float, float]] = []
    for seg in raw:
        start = float(seg["start"])
        end = float(seg["end"])
        # Split anything over VAD_MAX_CHUNK_S into equal-ish pieces.
        span = end - start
        if span <= VAD_MAX_CHUNK_S:
            segments.append((start, end))
            continue
        n_pieces = int(span // VAD_MAX_CHUNK_S) + 1
        piece = span / n_pieces
        for k in range(n_pieces):
            segments.append((start + k * piece, start + (k + 1) * piece))

    return segments


def _export_chunk(wav_path: str, start_s: float, end_s: float, out_path: str):
    """Slice [start_s, end_s) of a 16 kHz mono WAV into a new WAV."""
    import soundfile as sf

    info = sf.info(wav_path)
    sr = info.samplerate
    start_frame = max(0, int(start_s * sr))
    end_frame = min(info.frames, int(end_s * sr))
    if end_frame <= start_frame:
        end_frame = min(info.frames, start_frame + 1)
    data, _ = sf.read(
        wav_path,
        start=start_frame,
        frames=end_frame - start_frame,
        dtype="float32",
        always_2d=False,
    )
    sf.write(out_path, data, sr, subtype="PCM_16")


def _merge_chunk_results(
    chunk_results: list[dict], chunk_starts: list[float]
) -> dict:
    """Shift per-chunk timestamps to absolute time and concatenate.

    VAD-produced chunks are non-overlapping, so no dedup is required —
    every word from every chunk is kept and its timestamps offset by the
    chunk start.
    """
    merged_word_timestamps: list[dict] = []
    merged_words: list[dict] = []
    merged_segments: list[dict] = []

    for i, result in enumerate(chunk_results):
        offset = chunk_starts[i]

        wts_src = result.get("word_timestamps", []) or []
        words_src = result.get("words", []) or []
        segments_src = result.get("segments", []) or []
        aligned = len(words_src) == len(wts_src)

        for j, wt in enumerate(wts_src):
            abs_start = float(wt.get("start", 0)) + offset
            abs_end = float(wt.get("end", 0)) + offset
            merged_word_timestamps.append({**wt, "start": abs_start, "end": abs_end})
            if aligned:
                merged_words.append(words_src[j])

        for seg in segments_src:
            abs_start = float(seg.get("start", 0)) + offset
            abs_end = float(seg.get("end", 0)) + offset
            merged_segments.append({**seg, "start": abs_start, "end": abs_end})

    text = " ".join(
        str(wt.get("word", "")).strip()
        for wt in merged_word_timestamps
        if str(wt.get("word", "")).strip()
    )

    # Fall back to concatenating per-chunk text if no word timestamps came back.
    if not text:
        text = " ".join(
            str(r.get("text", "")).strip() for r in chunk_results if r.get("text")
        ).strip()

    merged: dict = {"text": text}
    if merged_words:
        merged["words"] = merged_words
    if merged_word_timestamps:
        merged["word_timestamps"] = merged_word_timestamps
    if merged_segments:
        merged["segments"] = merged_segments
    return merged


def _parse_vllm_response(payload: dict) -> dict:
    """Normalise a vLLM verbose_json transcription response into the same
    shape `_merge_chunk_results` expects: {text, words?, word_timestamps?, segments?}.
    """
    out: dict = {"text": payload.get("text", "")}

    words_raw = payload.get("words") or []
    if words_raw:
        word_ts = []
        words_list = []
        for w in words_raw:
            word_text = w.get("word") if isinstance(w, dict) else None
            if word_text is None:
                continue
            entry = {
                "word": word_text,
                "start": float(w.get("start", 0)),
                "end": float(w.get("end", 0)),
            }
            word_ts.append(entry)
            words_list.append({"word": word_text})
        if word_ts:
            out["word_timestamps"] = word_ts
            out["words"] = words_list

    segments_raw = payload.get("segments") or []
    if segments_raw:
        out["segments"] = [
            {
                "start": float(s.get("start", 0)),
                "end": float(s.get("end", 0)),
                "text": s.get("text", ""),
            }
            for s in segments_raw
            if isinstance(s, dict)
        ]

    return out


async def _transcribe_chunk_via_vllm(chunk_path: str) -> dict:
    """POST one chunk to vLLM's /v1/audio/transcriptions and parse the response."""
    if vllm_client is None:
        raise RuntimeError("vLLM ASR client not initialised")

    with open(chunk_path, "rb") as f:
        chunk_bytes = f.read()

    files = {"file": (os.path.basename(chunk_path), chunk_bytes, "audio/wav")}
    data = [
        ("model", HVISKE_MODEL),
        ("language", "da"),
        ("response_format", "verbose_json"),
        ("timestamp_granularities[]", "word"),
        ("timestamp_granularities[]", "segment"),
    ]

    resp = await vllm_client.post("/audio/transcriptions", files=files, data=data)
    resp.raise_for_status()
    return _parse_vllm_response(resp.json())


async def do_transcribe(wav_path: str, timestamps: bool = False) -> dict:
    """VAD-chunk a 16 kHz mono WAV, transcribe each chunk via vLLM, merge.

    `timestamps` controls only the *response shape*: word/segment timestamps
    are always requested from vLLM (the diarization merge needs them), but
    are stripped from the response when the caller didn't ask for them.
    """
    segments = await asyncio.to_thread(_vad_segments, wav_path)

    if not segments:
        return {"text": ""}

    with tempfile.TemporaryDirectory() as chunk_dir:
        chunk_paths: list[str] = []
        chunk_starts: list[float] = []
        for idx, (start_s, end_s) in enumerate(segments):
            chunk_path = os.path.join(chunk_dir, f"chunk_{idx:05d}.wav")
            await asyncio.to_thread(_export_chunk, wav_path, start_s, end_s, chunk_path)
            chunk_paths.append(chunk_path)
            chunk_starts.append(start_s)

        sem = asyncio.Semaphore(ASR_CONCURRENCY)

        async def _run(path: str) -> dict:
            async with sem:
                return await _transcribe_chunk_via_vllm(path)

        chunk_results = await asyncio.gather(*(_run(p) for p in chunk_paths))

    merged = _merge_chunk_results(chunk_results, chunk_starts)
    if not timestamps:
        return {"text": merged.get("text", "")}
    return merged


def do_diarize(audio_path: str) -> list[dict]:
    """Run pyannote diarization on audio file. Returns list of {speaker, start, end}."""
    result = diarization_pipeline(audio_path)
    # pyannote 4.x returns DiarizeOutput with .speaker_diarization attribute
    # pyannote 3.x returns Annotation directly
    annotation = getattr(result, "speaker_diarization", result)
    segments = []
    for turn, _, speaker in annotation.itertracks(yield_label=True):
        segments.append({
            "speaker": speaker,
            "start": turn.start,
            "end": turn.end,
        })
    return segments


def merge_transcription_and_diarization(
    transcription: dict, diarization_segments: list[dict]
) -> str:
    """Merge word timestamps with pyannote speaker segments.

    Returns markdown-formatted text with speaker labels like:
    **Speaker 1:** text here

    **Speaker 2:** other text here
    """
    word_timestamps = transcription.get("word_timestamps", [])

    if not word_timestamps or not diarization_segments:
        return transcription.get("text", "")

    speaker_order: dict[str, int] = {}
    labeled_words = []

    for wt in word_timestamps:
        word = wt.get("word", "")
        ws = wt.get("start", 0)
        we = wt.get("end", 0)

        speaker_overlaps: dict[str, float] = {}
        for seg in diarization_segments:
            overlap = max(0, min(we, seg["end"]) - max(ws, seg["start"]))
            if overlap > 0:
                speaker_overlaps[seg["speaker"]] = (
                    speaker_overlaps.get(seg["speaker"], 0) + overlap
                )

        if speaker_overlaps:
            best_speaker = max(speaker_overlaps, key=speaker_overlaps.get)
        else:
            best_speaker = min(
                diarization_segments,
                key=lambda s: min(abs(ws - s["end"]), abs(s["start"] - we)),
            )["speaker"]

        if best_speaker not in speaker_order:
            speaker_order[best_speaker] = len(speaker_order) + 1

        labeled_words.append({"word": word, "speaker": best_speaker})

    blocks = []
    current_speaker = None
    current_words: list[str] = []

    for lw in labeled_words:
        if lw["speaker"] != current_speaker:
            if current_words:
                blocks.append({
                    "speaker": current_speaker,
                    "text": " ".join(current_words),
                })
            current_speaker = lw["speaker"]
            current_words = [lw["word"]]
        else:
            current_words.append(lw["word"])

    if current_words:
        blocks.append({
            "speaker": current_speaker,
            "text": " ".join(current_words),
        })

    parts = []
    for block in blocks:
        speaker_num = speaker_order[block["speaker"]]
        parts.append(f"**Speaker {speaker_num}:** {block['text']}")

    return "\n\n".join(parts)


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model: Optional[str] = Form(None),
    stream: Optional[str] = Form(None),
    timestamps: Optional[str] = Form(None),
):
    """
    Transcribe audio using syvai/hviske-v5.1 served by vLLM, with silero-VAD
    chunking and pyannote speaker diarization.

    Accepts the same multipart form interface as OpenAI Whisper API.
    Pass timestamps=true to get word-level and segment-level timestamps.
    """
    want_timestamps = timestamps and timestamps.lower() == "true"

    with tempfile.TemporaryDirectory() as tmpdir:
        filename = file.filename or "audio"
        input_path = os.path.join(tmpdir, filename)
        content = await file.read()

        if not content:
            return JSONResponse(
                content={"error": "Uploaded file is empty."},
                status_code=400,
            )

        with open(input_path, "wb") as f:
            f.write(content)

        wav_path = os.path.join(tmpdir, "audio.wav")
        try:
            convert_to_wav(input_path, wav_path)
        except ValueError as e:
            return JSONResponse(
                content={"error": str(e)},
                status_code=422,
            )

        loop = asyncio.get_event_loop()

        try:
            if diarization_pipeline is not None:
                # Run diarization in a thread (pyannote is blocking) in
                # parallel with the (async) vLLM transcription fan-out.
                diarization_task = loop.run_in_executor(
                    None, do_diarize, wav_path
                )
                transcription_result = await do_transcribe(wav_path, True)
                diarization_segments = await diarization_task

                try:
                    merged_text = merge_transcription_and_diarization(
                        transcription_result, diarization_segments
                    )
                except Exception as e:
                    print(f"Warning: Diarization merge failed: {e}")
                    merged_text = transcription_result.get("text", "")

                result = {"text": merged_text}

                if want_timestamps:
                    for key in ("words", "segments", "word_timestamps"):
                        if key in transcription_result:
                            result[key] = transcription_result[key]
            else:
                result = await do_transcribe(wav_path, want_timestamps)
        except httpx.HTTPStatusError as e:
            body = e.response.text[:500] if e.response is not None else ""
            return JSONResponse(
                content={
                    "error": f"vLLM ASR request failed ({e.response.status_code}): {body}"
                },
                status_code=502,
            )
        except httpx.RequestError as e:
            return JSONResponse(
                content={"error": f"Could not reach vLLM ASR service: {e}"},
                status_code=503,
            )

        if not result.get("text", "").strip():
            return JSONResponse(
                content={"error": "Transcription produced empty output. The audio may be silent or unrecognizable."},
                status_code=422,
            )

        return JSONResponse(content=result)


@app.get("/health")
async def health():
    return {
        "status": "healthy",
        "vad_loaded": vad_model is not None,
        "vllm_asr_base_url": VLLM_ASR_BASE_URL,
        "hviske_model": HVISKE_MODEL,
        "diarization_loaded": diarization_pipeline is not None,
    }
