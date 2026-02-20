import os
import tempfile
import subprocess
import asyncio
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse

model = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global model
    import nemo.collections.asr as nemo_asr

    print("Loading NVIDIA Parakeet RNNT 110M Danish model...")
    model = nemo_asr.models.ASRModel.from_pretrained(
        model_name="nvidia/parakeet-rnnt-110m-da-dk"
    )
    model.eval()
    print("Model loaded successfully.")
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

        # Transcribe in thread pool to avoid blocking the event loop
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None, do_transcribe, wav_path, want_timestamps
        )

        return JSONResponse(content=result)


@app.get("/health")
async def health():
    return {"status": "healthy", "model_loaded": model is not None}
