import os
import gc
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

# Monkey-patch lhotse CutSampler to work with torch >= 2.10
# (lhotse 1.31.x passes data_source=None to Sampler.__init__ which torch 2.10 removed)
try:
    from lhotse.dataset.sampling.base import CutSampler
    _orig_init = CutSampler.__init__

    def _patched_init(self, *args, **kwargs):
        try:
            _orig_init(self, *args, **kwargs)
        except TypeError:
            from torch.utils.data import Sampler
            Sampler.__init__(self)
            _orig_init.__wrapped__ = True
            # Re-run without the super().__init__ call failing
            object.__setattr__(self, '_patched', True)
            _orig_init(self, *args, **kwargs)

    # Simpler approach: just patch Sampler to accept data_source
    from torch.utils.data import Sampler
    _orig_sampler_init = Sampler.__init__

    def _patched_sampler_init(self, data_source=None, **kwargs):
        if data_source is not None or kwargs:
            try:
                _orig_sampler_init(self, data_source=data_source, **kwargs)
            except TypeError:
                _orig_sampler_init(self)
        else:
            _orig_sampler_init(self)

    Sampler.__init__ = _patched_sampler_init
    print("Applied lhotse/torch compatibility patch.")
except Exception as e:
    print(f"Note: lhotse patch not needed or failed: {e}")

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse

model = None
diarization_pipeline = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global model, diarization_pipeline
    import nemo.collections.asr as nemo_asr

    stt_model = os.environ.get("STT_MODEL", "nvidia/parakeet-rnnt-110m-da-dk")
    print(f"Loading STT model: {stt_model}...")
    # NeMo 2.7+ bug: ASRModel.from_pretrained() fails to resolve the concrete
    # subclass from config, so we use EncDecRNNTBPEModel directly.
    model = nemo_asr.models.EncDecRNNTBPEModel.from_pretrained(
        model_name=stt_model
    )
    model.eval()
    print("Model loaded successfully.")

    # Load pyannote speaker diarization pipeline
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

    yield


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

    # Validate output is not empty — a WAV header alone is 44 bytes (#62)
    file_size = os.path.getsize(output_path)
    if file_size <= 44:
        raise ValueError(
            f"ffmpeg produced an empty audio file ({file_size} bytes). "
            "The input may be silent, corrupted, or in an unsupported format."
        )


# Chunked transcription keeps Conformer self-attention bounded for long audio
# (#72). Conformer rel-pos attention is O(T²) in sequence length; feeding a
# multi-hour file in one pass OOMs the GPU.
CHUNK_LENGTH_S = float(os.environ.get("CHUNK_LENGTH_S", "30"))
CHUNK_OVERLAP_S = float(os.environ.get("CHUNK_OVERLAP_S", "2"))
CHUNK_THRESHOLD_S = float(os.environ.get("CHUNK_THRESHOLD_S", "60"))


def _probe_duration(wav_path: str) -> float:
    import soundfile as sf

    info = sf.info(wav_path)
    return float(info.frames) / float(info.samplerate)


def _split_wav(
    wav_path: str, tmpdir: str, chunk_len: float, overlap: float
) -> list[tuple[str, float]]:
    """Slice a WAV into overlapping chunk files.

    Returns [(chunk_path, start_seconds), ...]. Chunks are written as
    16-bit PCM WAVs next to the source file.
    """
    import soundfile as sf

    info = sf.info(wav_path)
    sr = info.samplerate
    total_frames = info.frames
    chunk_frames = int(chunk_len * sr)
    step_frames = int(max(chunk_len - overlap, 0.1) * sr)

    chunks: list[tuple[str, float]] = []
    start_frame = 0
    idx = 0
    while start_frame < total_frames:
        frames_to_read = min(chunk_frames, total_frames - start_frame)
        data, _ = sf.read(
            wav_path,
            start=start_frame,
            frames=frames_to_read,
            dtype="float32",
            always_2d=False,
        )
        chunk_path = os.path.join(tmpdir, f"chunk_{idx:05d}.wav")
        sf.write(chunk_path, data, sr, subtype="PCM_16")
        chunks.append((chunk_path, start_frame / sr))
        if start_frame + frames_to_read >= total_frames:
            break
        start_frame += step_frames
        idx += 1
    return chunks


def _merge_chunk_results(
    chunk_results: list[dict], chunk_starts: list[float], overlap: float
) -> dict:
    """Merge per-chunk transcriptions with timestamp shifting and overlap dedup.

    Each chunk's timestamps are offset to absolute time, then words/segments
    falling in an overlap window are assigned to one chunk using the
    midpoint rule (midpoint between consecutive chunks = start_{i+1} + overlap/2).
    Text is rebuilt from the merged word list to guarantee no duplication.
    """
    n = len(chunk_results)
    # Boundaries in absolute seconds. `bounds[i]` is the left edge of chunk i's
    # owned range; `bounds[i+1]` is its right edge. First left = -inf,
    # last right = +inf.
    bounds: list[float] = [float("-inf")]
    for i in range(n - 1):
        bounds.append(chunk_starts[i + 1] + overlap / 2.0)
    bounds.append(float("inf"))

    merged_word_timestamps: list[dict] = []
    merged_words: list[dict] = []
    merged_segments: list[dict] = []

    for i, result in enumerate(chunk_results):
        offset = chunk_starts[i]
        left, right = bounds[i], bounds[i + 1]

        wts_src = result.get("word_timestamps", []) or []
        words_src = result.get("words", []) or []
        segments_src = result.get("segments", []) or []
        aligned = len(words_src) == len(wts_src)

        for j, wt in enumerate(wts_src):
            abs_start = float(wt.get("start", 0)) + offset
            abs_end = float(wt.get("end", 0)) + offset
            mid = (abs_start + abs_end) / 2.0
            if mid < left or mid >= right:
                continue
            merged_word_timestamps.append({**wt, "start": abs_start, "end": abs_end})
            if aligned:
                merged_words.append(words_src[j])

        for seg in segments_src:
            abs_start = float(seg.get("start", 0)) + offset
            abs_end = float(seg.get("end", 0)) + offset
            mid = (abs_start + abs_end) / 2.0
            if mid < left or mid >= right:
                continue
            merged_segments.append({**seg, "start": abs_start, "end": abs_end})

    text = " ".join(
        str(wt.get("word", "")).strip()
        for wt in merged_word_timestamps
        if str(wt.get("word", "")).strip()
    )

    merged: dict = {"text": text}
    if merged_words:
        merged["words"] = merged_words
    if merged_word_timestamps:
        merged["word_timestamps"] = merged_word_timestamps
    if merged_segments:
        merged["segments"] = merged_segments
    return merged


def _transcribe_one(audio_path: str, timestamps: bool) -> dict:
    """Single-pass NeMo transcription. Used directly for short audio and as
    the per-chunk primitive for long audio."""
    output = model.transcribe(
        [audio_path], return_hypotheses=timestamps, timestamps=timestamps
    )
    hyp = output[0]

    if not timestamps:
        text = hyp.text if hasattr(hyp, "text") else str(hyp)
        return {"text": text}

    # With return_hypotheses=True, output may be nested [[Hypothesis]]
    if isinstance(hyp, list):
        hyp = hyp[0]

    result: dict = {"text": hyp.text}

    if hasattr(hyp, "words") and hyp.words:
        words = []
        confidences_raw = getattr(hyp, "word_confidence", None)
        confidences = (
            list(confidences_raw)
            if confidences_raw is not None and len(confidences_raw) > 0
            else []
        )
        for i, word in enumerate(hyp.words):
            entry: dict = {"word": word}
            if i < len(confidences):
                entry["confidence"] = round(confidences[i], 3)
            words.append(entry)
        result["words"] = words

    ts = getattr(hyp, "timestamp", None) or getattr(hyp, "timestep", None)
    if ts and isinstance(ts, dict):
        if "segment" in ts:
            result["segments"] = ts["segment"]
        if "word" in ts:
            result["word_timestamps"] = ts["word"]

    return result


def do_transcribe(audio_path: str, timestamps: bool = False) -> dict:
    """Transcribe audio file. Runs synchronously (call from thread pool).

    Freezes the encoder before transcription to satisfy NeMo's
    freeze/unfreeze lifecycle (#63). For audio longer than CHUNK_THRESHOLD_S,
    splits into overlapping windows and transcribes sequentially to avoid
    Conformer self-attention OOM (#72).
    """
    # Freeze encoder before transcription so NeMo can safely unfreeze it
    # during _transcribe_on_end.
    if hasattr(model, "encoder") and hasattr(model.encoder, "freeze"):
        try:
            model.encoder.freeze()
        except Exception:
            pass  # Already frozen or not applicable

    try:
        duration = _probe_duration(audio_path)
    except Exception as e:
        print(f"Note: could not probe audio duration ({e}); using single-pass path.")
        return _transcribe_one(audio_path, timestamps)

    if duration <= CHUNK_THRESHOLD_S:
        return _transcribe_one(audio_path, timestamps)

    import torch

    with tempfile.TemporaryDirectory() as chunk_dir:
        chunks = _split_wav(audio_path, chunk_dir, CHUNK_LENGTH_S, CHUNK_OVERLAP_S)
        if not chunks:
            return _transcribe_one(audio_path, timestamps)

        chunk_results: list[dict] = []
        chunk_starts: list[float] = []
        for idx, (chunk_path, start_sec) in enumerate(chunks):
            # Request timestamps per chunk so we can dedup overlap, even if
            # the caller didn't ask for them.
            chunk_results.append(_transcribe_one(chunk_path, True))
            chunk_starts.append(start_sec)
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            if (idx + 1) % 8 == 0:
                gc.collect()

    merged = _merge_chunk_results(chunk_results, chunk_starts, CHUNK_OVERLAP_S)
    if not timestamps:
        # Match the short-file contract: only `text` when timestamps not requested.
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
    """Merge NeMo word timestamps with pyannote speaker segments.

    Returns markdown-formatted text with speaker labels like:
    **Speaker 1:** text here

    **Speaker 2:** other text here
    """
    word_timestamps = transcription.get("word_timestamps", [])

    if not word_timestamps or not diarization_segments:
        return transcription.get("text", "")

    # Assign each word to the speaker with maximum overlap
    speaker_order = {}  # Maps pyannote label -> display number
    labeled_words = []

    for wt in word_timestamps:
        word = wt.get("word", "")
        ws = wt.get("start", 0)
        we = wt.get("end", 0)

        # Calculate overlap with each speaker
        speaker_overlaps: dict[str, float] = {}
        for seg in diarization_segments:
            overlap = max(0, min(we, seg["end"]) - max(ws, seg["start"]))
            if overlap > 0:
                speaker_overlaps[seg["speaker"]] = (
                    speaker_overlaps.get(seg["speaker"], 0) + overlap
                )

        # Assign to speaker with maximum overlap
        if speaker_overlaps:
            best_speaker = max(speaker_overlaps, key=speaker_overlaps.get)
        else:
            # Word falls outside all diarization segments — assign to nearest segment
            best_speaker = min(
                diarization_segments,
                key=lambda s: min(abs(ws - s["end"]), abs(s["start"] - we)),
            )["speaker"]

        # Track speaker order of first appearance
        if best_speaker not in speaker_order:
            speaker_order[best_speaker] = len(speaker_order) + 1

        labeled_words.append({"word": word, "speaker": best_speaker})

    # Group consecutive same-speaker words into blocks
    blocks = []
    current_speaker = None
    current_words = []

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

    # Format as markdown with speaker labels
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
    Transcribe audio using NVIDIA Parakeet RNNT 110M Danish model.
    Accepts the same multipart form interface as OpenAI Whisper API.
    Pass timestamps=true to get word-level and segment-level timestamps.

    When pyannote diarization is available, automatically runs speaker
    diarization and returns speaker-labeled text.
    """
    want_timestamps = timestamps and timestamps.lower() == "true"

    with tempfile.TemporaryDirectory() as tmpdir:
        # Save uploaded file
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

        # Convert to 16kHz mono WAV (NeMo expects this format)
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
                # Serialize diarization then ASR to keep GPU peak predictable
                # across hardware tiers (#72). Diarization output is small, so
                # its footprint is negligible once it finishes.
                diarization_segments = await loop.run_in_executor(
                    None, do_diarize, wav_path
                )
                transcription_result = await loop.run_in_executor(
                    None, do_transcribe, wav_path, True
                )

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
                result = await loop.run_in_executor(
                    None, do_transcribe, wav_path, want_timestamps
                )
        except RuntimeError as e:
            # Covers torch.cuda.OutOfMemoryError (subclass of RuntimeError in
            # torch 2.1+). Release allocator blocks and return a structured
            # 413 so the frontend can render an actionable message instead
            # of a generic 500 (#72).
            if "out of memory" not in str(e).lower():
                raise
            try:
                import torch

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass
            return JSONResponse(
                content={
                    "error": (
                        "Audio too long to transcribe on this GPU. "
                        "Try a shorter file or lower CHUNK_LENGTH_S."
                    )
                },
                status_code=413,
            )

        # Validate non-empty transcription (#62)
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
        "model_loaded": model is not None,
        "diarization_loaded": diarization_pipeline is not None,
    }
