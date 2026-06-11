"""Self-hosted speaker diarization microservice.

Wraps pyannote.audio 4.0 (speaker-diarization-community-1) behind a tiny FastAPI
app. The Next.js app sends one audio file of a full meeting recording and gets back
speaker turns ("who spoke when"); those are merged onto the hviske transcript by
time-overlap. Diarization is acoustic and language-agnostic, so it runs independently
of the Danish STT model.

The model weights are baked into the image at build time (see Dockerfile), so this
service never reaches the network at request time — important for the GDPR posture.
"""

import os
import tempfile

import torch
from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pyannote.audio import Pipeline

MODEL_NAME = os.environ.get("DIARIZATION_MODEL", "pyannote/speaker-diarization-community-1")
API_KEY = os.environ.get("DIARIZATION_API_KEY", "")
# HF token only needed at build/download time; weights are cached in the image.
HF_TOKEN = os.environ.get("HF_TOKEN")

app = FastAPI(title="diarization-service")
_bearer = HTTPBearer(auto_error=False)

# Loaded once at startup and reused across requests.
_pipeline: Pipeline | None = None


def get_pipeline() -> Pipeline:
    global _pipeline
    if _pipeline is None:
        _pipeline = Pipeline.from_pretrained(MODEL_NAME, use_auth_token=HF_TOKEN)
        if torch.cuda.is_available():
            _pipeline.to(torch.device("cuda"))
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


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "model": MODEL_NAME, "cuda": torch.cuda.is_available()}


@app.post("/diarize")
async def diarize(
    audio: UploadFile = File(...),
    _: None = Depends(require_auth),
) -> dict:
    data = await audio.read()
    if len(data) < 2_000:
        return {"turns": []}

    suffix = os.path.splitext(audio.filename or "")[1] or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as tmp:
        tmp.write(data)
        tmp.flush()
        # exclusive_speaker_diarization keeps at most one speaker active per instant,
        # which simplifies merging turns onto STT segments by time-overlap.
        output = get_pipeline()(tmp.name)
        annotation = getattr(output, "exclusive_speaker_diarization", output)

    turns = [
        {"speaker": speaker, "start": round(float(segment.start), 3), "end": round(float(segment.end), 3)}
        for segment, _, speaker in annotation.itertracks(yield_label=True)
    ]
    turns.sort(key=lambda t: t["start"])
    return {"turns": turns}
