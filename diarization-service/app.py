"""Self-hosted speaker diarization microservice.

Wraps pyannote.audio 4.0 (speaker-diarization-community-1) behind a tiny FastAPI
app. The Next.js app sends one audio file of a full meeting recording and gets back
speaker turns ("who spoke when"); those are merged onto the hviske transcript by
time-overlap. Diarization is acoustic and language-agnostic, so it runs independently
of the Danish STT model.

The model weights are baked into the image at build time (see Dockerfile), so this
service never reaches the network at request time — important for the GDPR posture.
"""

import io
import os
import wave

import numpy as np
import torch
from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pyannote.audio import Pipeline

MODEL_NAME = os.environ.get("DIARIZATION_MODEL", "pyannote/speaker-diarization-community-1")
API_KEY = os.environ.get("DIARIZATION_API_KEY", "")
# Inference device: "cpu", "cuda", or unset for auto. Force "cpu" when the GPU is
# already saturated by another model (e.g. the STT server) to avoid CUDA OOM.
DEVICE = os.environ.get("DIARIZATION_DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu")
# Gated-model auth. huggingface_hub also reads HF_TOKEN from the environment, so the
# weights download even if the kwarg name differs across pyannote releases.
HF_TOKEN = os.environ.get("HF_TOKEN")

app = FastAPI(title="diarization-service")
_bearer = HTTPBearer(auto_error=False)

# Loaded once at startup and reused across requests.
_pipeline: Pipeline | None = None


def get_pipeline() -> Pipeline:
    global _pipeline
    if _pipeline is None:
        try:
            pipeline = Pipeline.from_pretrained(MODEL_NAME, token=HF_TOKEN)
        except TypeError:
            # Older pyannote releases use the `use_auth_token` kwarg name.
            pipeline = Pipeline.from_pretrained(MODEL_NAME, use_auth_token=HF_TOKEN)
        _pipeline = pipeline.to(torch.device(DEVICE))
    return _pipeline


def require_auth(creds: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> None:
    # When no key is configured (e.g. local dev) auth is disabled, mirroring how the
    # Next.js provider sends no Authorization header if DIARIZATION_API_KEY is unset.
    if not API_KEY:
        return
    if creds is None or creds.credentials != API_KEY:
        raise HTTPException(status_code=401, detail="Unauthorized")


@app.on_event("startup")
def _warm() -> None:
    # Load the model eagerly so the first real request isn't paying the cold start.
    get_pipeline()


def _annotation_from(output):
    """Return the diarization Annotation regardless of pyannote's output shape.

    Depending on model/version, calling the pipeline returns either an Annotation
    directly, or a wrapper exposing `.exclusive_speaker_diarization` (preferred —
    one speaker per instant, simplifies time-overlap merge) and/or
    `.speaker_diarization`. Pick the first that supports `itertracks`.
    """
    for candidate in (
        getattr(output, "exclusive_speaker_diarization", None),
        getattr(output, "speaker_diarization", None),
        output,
    ):
        if candidate is not None and hasattr(candidate, "itertracks"):
            return candidate
    raise RuntimeError("pyannote output has no iterable diarization annotation")


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "model": MODEL_NAME, "device": DEVICE}


def _load_wav(data: bytes) -> tuple[torch.Tensor, int]:
    """Decode a PCM WAV into a (channel, time) float32 waveform + sample rate.

    The Next.js app always sends a 16 kHz mono PCM WAV, so we decode it with the
    stdlib `wave` module and hand pyannote an in-memory waveform. This sidesteps
    pyannote 4's file I/O (torchcodec/ffmpeg), which isn't reliably available on
    every host.
    """
    with wave.open(io.BytesIO(data), "rb") as w:
        n_channels = w.getnchannels()
        sample_rate = w.getframerate()
        sample_width = w.getsampwidth()
        frames = w.readframes(w.getnframes())

    if sample_width != 2:
        raise HTTPException(status_code=400, detail="Only 16-bit PCM WAV is supported")

    samples = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if n_channels > 1:
        samples = samples.reshape(-1, n_channels).mean(axis=1)  # downmix to mono
    waveform = torch.from_numpy(samples).unsqueeze(0)  # (1, time)
    return waveform, sample_rate


@app.post("/diarize")
async def diarize(
    audio: UploadFile = File(...),
    _: None = Depends(require_auth),
) -> dict:
    data = await audio.read()
    if len(data) < 2_000:
        return {"turns": []}

    waveform, sample_rate = _load_wav(data)
    output = get_pipeline()({"waveform": waveform, "sample_rate": sample_rate})
    annotation = _annotation_from(output)

    turns = [
        {"speaker": speaker, "start": round(float(segment.start), 3), "end": round(float(segment.end), 3)}
        for segment, _, speaker in annotation.itertracks(yield_label=True)
    ]
    turns.sort(key=lambda t: t["start"])
    return {"turns": turns}
