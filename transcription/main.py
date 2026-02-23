import os
import tempfile
import subprocess
import asyncio
from contextlib import asynccontextmanager
from typing import Optional

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

    print("Loading NVIDIA Parakeet RNNT 110M Danish model...")
    model = nemo_asr.models.ASRModel.from_pretrained(
        model_name="nvidia/parakeet-rnnt-110m-da-dk"
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
    """Convert audio to 16kHz mono WAV using ffmpeg."""
    subprocess.run(
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
        check=True,
        capture_output=True,
    )


def do_transcribe(audio_path: str, timestamps: bool = False) -> dict:
    """Transcribe audio file. Runs synchronously (call from thread pool)."""
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

    result = {"text": hyp.text}

    # Word-level timestamps and confidence
    if hasattr(hyp, "words") and hyp.words:
        words = []
        confidences_raw = getattr(hyp, "word_confidence", None)
        confidences = list(confidences_raw) if confidences_raw is not None and len(confidences_raw) > 0 else []
        for i, word in enumerate(hyp.words):
            entry = {"word": word}
            if i < len(confidences):
                entry["confidence"] = round(confidences[i], 3)
            words.append(entry)
        result["words"] = words

    # Timestamp dict (segment/word/char level)
    ts = getattr(hyp, "timestamp", None) or getattr(hyp, "timestep", None)
    if ts and isinstance(ts, dict):
        if "segment" in ts:
            result["segments"] = ts["segment"]
        if "word" in ts:
            result["word_timestamps"] = ts["word"]

    return result


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
        with open(input_path, "wb") as f:
            f.write(await file.read())

        # Convert to 16kHz mono WAV (NeMo expects this format)
        wav_path = os.path.join(tmpdir, "audio.wav")
        convert_to_wav(input_path, wav_path)

        loop = asyncio.get_event_loop()

        if diarization_pipeline is not None:
            # Run transcription (with timestamps) and diarization in parallel
            transcribe_future = loop.run_in_executor(
                None, do_transcribe, wav_path, True
            )
            diarize_future = loop.run_in_executor(
                None, do_diarize, wav_path
            )

            transcription_result, diarization_segments = await asyncio.gather(
                transcribe_future, diarize_future
            )

            # Merge transcription with speaker labels
            try:
                merged_text = merge_transcription_and_diarization(
                    transcription_result, diarization_segments
                )
            except Exception as e:
                print(f"Warning: Diarization merge failed: {e}")
                merged_text = transcription_result.get("text", "")

            result = {"text": merged_text}

            # Include raw timestamps if explicitly requested
            if want_timestamps:
                for key in ("words", "segments", "word_timestamps"):
                    if key in transcription_result:
                        result[key] = transcription_result[key]

            return JSONResponse(content=result)
        else:
            # No diarization — plain transcription
            result = await loop.run_in_executor(
                None, do_transcribe, wav_path, want_timestamps
            )
            return JSONResponse(content=result)


@app.get("/health")
async def health():
    return {
        "status": "healthy",
        "model_loaded": model is not None,
        "diarization_loaded": diarization_pipeline is not None,
    }
