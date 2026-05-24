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

# PyTorch 2.6 changed `torch.load`'s default `weights_only` from False to True.
# pyannote 3.x ships pickled checkpoints referencing internal classes that the
# new safe-loader rejects. Force False so pyannote can load its weights.
try:
    import torch

    _orig_torch_load = torch.load

    def _torch_load_weights_only_false(*args, **kwargs):
        kwargs["weights_only"] = False
        return _orig_torch_load(*args, **kwargs)

    torch.load = _torch_load_weights_only_false
    import torch.serialization
    torch.serialization.load = _torch_load_weights_only_false
except Exception as e:
    print(f"Note: torch.load shim skipped ({e}).")

diarization_pipeline = None

VLLM_ASR_BASE_URL = os.environ.get("VLLM_ASR_BASE_URL", "http://vllm-asr:8000/v1").rstrip("/")
HVISKE_MODEL = os.environ.get("HVISKE_MODEL", "syvai/hviske-v5.1")

# hviske-v5.1 has an effective audio ceiling of 31 s. Cap chunks under that.
CHUNK_MAX_S = float(os.environ.get("CHUNK_MAX_S", "28.0"))
# Fallback chunk size when diarization is disabled.
CHUNK_FALLBACK_S = float(os.environ.get("CHUNK_FALLBACK_S", "28.0"))
ASR_CONCURRENCY = int(os.environ.get("ASR_CONCURRENCY", "32"))
VLLM_REQUEST_TIMEOUT_S = float(os.environ.get("VLLM_REQUEST_TIMEOUT_S", "300"))
VLLM_API_KEY = os.environ.get("VLLM_API_KEY", "").strip()


@asynccontextmanager
async def lifespan(app: FastAPI):
    global diarization_pipeline

    print(f"vLLM ASR target: {VLLM_ASR_BASE_URL} (model={HVISKE_MODEL}).")

    hf_token = os.environ.get("HF_TOKEN", "").strip()
    if hf_token:
        try:
            from pyannote.audio import Pipeline

            diarization_model = os.environ.get(
                "DIARIZATION_MODEL", "pyannote/speaker-diarization-community-1"
            )
            print(f"Loading pyannote diarization pipeline: {diarization_model}...")
            # pyannote 4.x uses `token=`. Fall back to `use_auth_token=` for
            # any pinned 3.x environment.
            try:
                diarization_pipeline = Pipeline.from_pretrained(
                    diarization_model,
                    token=hf_token,
                )
            except TypeError:
                diarization_pipeline = Pipeline.from_pretrained(
                    diarization_model,
                    use_auth_token=hf_token,
                )
            import torch
            if torch.cuda.is_available():
                diarization_pipeline.to(torch.device("cuda"))
            print("Pyannote diarization pipeline loaded.")
        except Exception as e:
            print(f"Warning: Failed to load pyannote diarization pipeline: {e}")
            diarization_pipeline = None
    else:
        print("HF_TOKEN not set — speaker diarization disabled.")

    yield


app = FastAPI(lifespan=lifespan)


def convert_to_wav(input_path: str, output_path: str):
    """Convert audio to 16 kHz mono WAV using ffmpeg."""
    result = subprocess.run(
        ["ffmpeg", "-i", input_path, "-ar", "16000", "-ac", "1", "-f", "wav", output_path, "-y"],
        capture_output=True,
    )
    if result.returncode != 0:
        stderr = result.stderr.decode(errors="replace")[:500]
        raise ValueError(f"ffmpeg conversion failed: {stderr}")
    if os.path.getsize(output_path) <= 44:
        raise ValueError("ffmpeg produced an empty audio file.")


def _probe_duration(wav_path: str) -> float:
    import soundfile as sf
    info = sf.info(wav_path)
    return float(info.frames) / float(info.samplerate)


def _split_long(start: float, end: float, max_s: float) -> list[tuple[float, float]]:
    """Split a segment longer than max_s into roughly equal pieces."""
    span = end - start
    if span <= max_s:
        return [(start, end)]
    n = int(span // max_s) + 1
    piece = span / n
    return [(start + k * piece, start + (k + 1) * piece) for k in range(n)]


def _export_chunk(wav_path: str, start_s: float, end_s: float, out_path: str):
    import soundfile as sf
    info = sf.info(wav_path)
    sr = info.samplerate
    start_frame = max(0, int(start_s * sr))
    end_frame = min(info.frames, int(end_s * sr))
    if end_frame <= start_frame:
        end_frame = min(info.frames, start_frame + 1)
    data, _ = sf.read(wav_path, start=start_frame, frames=end_frame - start_frame,
                      dtype="float32", always_2d=False)
    sf.write(out_path, data, sr, subtype="PCM_16")


def _parse_vllm_response(payload: dict) -> str:
    return (payload.get("text") or "").strip()


def _transcribe_chunk_sync(chunk_path: str) -> str:
    headers = {}
    if VLLM_API_KEY:
        headers["Authorization"] = f"Bearer {VLLM_API_KEY}"
    
    with open(chunk_path, "rb") as f:
        chunk_bytes = f.read()
    files = {"file": (os.path.basename(chunk_path), chunk_bytes, "audio/wav")}
    data = {"model": HVISKE_MODEL, "language": "da", "response_format": "json"}
    with httpx.Client(base_url=VLLM_ASR_BASE_URL,
                      timeout=httpx.Timeout(VLLM_REQUEST_TIMEOUT_S),
                      headers=headers) as client:
        resp = client.post("/audio/transcriptions", files=files, data=data)
    resp.raise_for_status()
    return _parse_vllm_response(resp.json())


def do_diarize(audio_path: str) -> list[dict]:
    """Run pyannote diarization. Returns [{speaker, start, end}, ...].

    Supports both the pyannote 4.x SpeakerDiarizationOutput (two-tuple
    `(turn, speaker)` iterator) and 3.x Annotation.itertracks(yield_label=True)
    (three-tuple `(turn, track, label)`).
    """
    result = diarization_pipeline(audio_path)
    sd = getattr(result, "speaker_diarization", result)
    out: list[dict] = []
    try:
        # pyannote 4.x: iterates as (turn, speaker)
        for turn, speaker in sd:
            out.append({"speaker": speaker, "start": turn.start, "end": turn.end})
    except (TypeError, ValueError):
        # pyannote 3.x: Annotation
        for turn, _, speaker in sd.itertracks(yield_label=True):
            out.append({"speaker": speaker, "start": turn.start, "end": turn.end})
    return out


def _segments_from_diarization(diar: list[dict]) -> list[dict]:
    """Convert diarization turns into ASR chunks, splitting any longer than
    CHUNK_MAX_S so they fit hviske's 31 s ceiling."""
    chunks: list[dict] = []
    for seg in diar:
        for s, e in _split_long(seg["start"], seg["end"], CHUNK_MAX_S):
            chunks.append({"speaker": seg["speaker"], "start": s, "end": e})
    return chunks


def _fallback_segments(audio_duration: float) -> list[dict]:
    """Fixed-size chunks when diarization isn't available."""
    chunks: list[dict] = []
    t = 0.0
    while t < audio_duration:
        end = min(t + CHUNK_FALLBACK_S, audio_duration)
        chunks.append({"speaker": None, "start": t, "end": end})
        t = end
    return chunks


async def _transcribe_segments(wav_path: str, segments: list[dict]) -> list[dict]:
    """Slice + transcribe in parallel. Returns segments with `text` filled in."""
    with tempfile.TemporaryDirectory() as chunk_dir:
        paths: list[str] = []
        for idx, seg in enumerate(segments):
            p = os.path.join(chunk_dir, f"chunk_{idx:05d}.wav")
            await asyncio.to_thread(_export_chunk, wav_path, seg["start"], seg["end"], p)
            paths.append(p)

        sem = asyncio.Semaphore(ASR_CONCURRENCY)

        async def _run(path: str) -> str:
            async with sem:
                return await asyncio.to_thread(_transcribe_chunk_sync, path)

        texts = await asyncio.gather(*(_run(p) for p in paths))
    return [{**seg, "text": t} for seg, t in zip(segments, texts)]


def _render(segments: list[dict]) -> str:
    """Build the final transcript. With speakers: markdown labels per block,
    adjacent same-speaker chunks merged. Without speakers: plain text join."""
    if not segments:
        return ""
    if all(seg.get("speaker") is None for seg in segments):
        return " ".join(s["text"] for s in segments if s.get("text")).strip()

    order: dict[str, int] = {}
    blocks: list[dict] = []
    for seg in segments:
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        spk = seg.get("speaker") or "?"
        if spk not in order:
            order[spk] = len(order) + 1
        if blocks and blocks[-1]["speaker"] == spk:
            blocks[-1]["text"] += " " + text
        else:
            blocks.append({"speaker": spk, "text": text})
    return "\n\n".join(f"**Speaker {order[b['speaker']]}:** {b['text']}" for b in blocks)


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model: Optional[str] = Form(None),
    stream: Optional[str] = Form(None),
    timestamps: Optional[str] = Form(None),
):
    """Transcribe audio using pyannote diarization for segmentation (when
    available) and syvai/hviske-v5.1 served by vLLM for ASR."""
    import time as _t

    want_timestamps = timestamps and timestamps.lower() == "true"

    with tempfile.TemporaryDirectory() as tmpdir:
        filename = file.filename or "audio"
        input_path = os.path.join(tmpdir, filename)
        content = await file.read()
        if not content:
            return JSONResponse(content={"error": "Uploaded file is empty."}, status_code=400)

        with open(input_path, "wb") as f:
            f.write(content)

        wav_path = os.path.join(tmpdir, "audio.wav")
        try:
            convert_to_wav(input_path, wav_path)
        except ValueError as e:
            return JSONResponse(content={"error": str(e)}, status_code=422)

        loop = asyncio.get_event_loop()
        t_start = _t.perf_counter()

        try:
            if diarization_pipeline is not None:
                t_d0 = _t.perf_counter()
                diar = await loop.run_in_executor(None, do_diarize, wav_path)
                t_diar = _t.perf_counter() - t_d0
                segments = _segments_from_diarization(diar)
            else:
                duration = await asyncio.to_thread(_probe_duration, wav_path)
                segments = _fallback_segments(duration)
                t_diar = 0.0

            if not segments:
                return JSONResponse(
                    content={"error": "No speech detected."},
                    status_code=422,
                )

            t_a0 = _t.perf_counter()
            segments = await _transcribe_segments(wav_path, segments)
            t_asr = _t.perf_counter() - t_a0

            text = _render(segments)
        except httpx.HTTPStatusError as e:
            body = e.response.text[:500] if e.response is not None else ""
            return JSONResponse(
                content={"error": f"vLLM ASR request failed ({e.response.status_code}): {body}"},
                status_code=502,
            )
        except httpx.RequestError as e:
            return JSONResponse(
                content={"error": f"Could not reach vLLM ASR service: {e}"},
                status_code=503,
            )

        wall = _t.perf_counter() - t_start
        print(
            f"[transcribe] segments={len(segments)} "
            f"diarize={t_diar:.2f}s asr={t_asr:.2f}s wall={wall:.2f}s "
            f"concurrency={ASR_CONCURRENCY}",
            flush=True,
        )

        if not text.strip():
            return JSONResponse(
                content={"error": "Transcription produced empty output."},
                status_code=422,
            )

        result = {"text": text}
        if want_timestamps:
            result["segments"] = [
                {"start": s["start"], "end": s["end"],
                 "speaker": s.get("speaker"), "text": s.get("text", "")}
                for s in segments
            ]
        return JSONResponse(content=result)


@app.get("/health")
async def health():
    return {
        "status": "healthy",
        "vllm_asr_base_url": VLLM_ASR_BASE_URL,
        "hviske_model": HVISKE_MODEL,
        "diarization_loaded": diarization_pipeline is not None,
    }
