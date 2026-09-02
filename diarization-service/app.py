"""Self-hosted speaker diarization microservice.

Wraps pyannote.audio 4.0 (speaker-diarization-community-1) behind a tiny FastAPI
app. The Next.js app sends one audio file of a full meeting recording and gets back
speaker turns ("who spoke when"); those are merged onto the hviske transcript by
time-overlap. Diarization is acoustic and language-agnostic, so it runs independently
of the Danish STT model.

The model weights are baked into the image at build time (see Dockerfile), so this
service never reaches the network at request time — important for the GDPR posture.
"""

import asyncio
import io
import os
import subprocess
import time
import wave

import numpy as np
import torch
from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from prometheus_client import Counter, Histogram
from prometheus_fastapi_instrumentator import Instrumentator
from pyannote.audio import Pipeline

MODEL_NAME = os.environ.get("DIARIZATION_MODEL", "pyannote/speaker-diarization-community-1")
API_KEY = os.environ.get("DIARIZATION_API_KEY", "")
# Inference device: "cpu", "cuda", or unset for auto. Force "cpu" when the GPU is
# already saturated by another model (e.g. the STT server) to avoid CUDA OOM.
DEVICE = os.environ.get("DIARIZATION_DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu")
# Gated-model auth. huggingface_hub also reads HF_TOKEN from the environment, so the
# weights download even if the kwarg name differs across pyannote releases.
HF_TOKEN = os.environ.get("HF_TOKEN")

# Whether /metrics requires the same bearer token as /diarize. Off by default: the
# service is not publicly exposed, and a Prometheus scraper that suddenly needs a
# credential fails silently (the series just stop). Turn it on where the service is
# reachable from outside the internal network.
METRICS_REQUIRE_AUTH = os.environ.get("DIARIZATION_METRICS_REQUIRE_AUTH", "").lower() in ("1", "true", "yes")

app = FastAPI(title="diarization-service")
_bearer = HTTPBearer(auto_error=False)

# Loaded once at startup and reused across requests.
_pipeline: Pipeline | None = None
# The pipeline is not safe for concurrent calls — serialize inference explicitly
# (decode can still overlap, and the event loop stays responsive for /health).
_inference_lock = asyncio.Lock()


# Batch sizes for the segmentation/embedding sub-models. The pyannote defaults
# (1/32 depending on version) leave a GPU mostly idle on long recordings; larger
# batches cut inference wall time several-fold. Tunable via env if VRAM is tight.
SEGMENTATION_BATCH_SIZE = int(os.environ.get("DIARIZATION_SEGMENTATION_BATCH_SIZE", "32"))
EMBEDDING_BATCH_SIZE = int(os.environ.get("DIARIZATION_EMBEDDING_BATCH_SIZE", "32"))


def get_pipeline() -> Pipeline:
    global _pipeline
    if _pipeline is None:
        try:
            pipeline = Pipeline.from_pretrained(MODEL_NAME, token=HF_TOKEN)
        except TypeError:
            # Older pyannote releases use the `use_auth_token` kwarg name.
            pipeline = Pipeline.from_pretrained(MODEL_NAME, use_auth_token=HF_TOKEN)
        for attr, value in (
            ("segmentation_batch_size", SEGMENTATION_BATCH_SIZE),
            ("embedding_batch_size", EMBEDDING_BATCH_SIZE),
        ):
            # Attribute names vary across pyannote releases — set only what exists.
            if hasattr(pipeline, attr):
                setattr(pipeline, attr, value)
        _pipeline = pipeline.to(torch.device(DEVICE))
        if DEVICE != "cuda":
            print(
                f"[diarization] WARNING: running on device '{DEVICE}'. A 100-minute "
                "meeting can take 10+ minutes on CPU vs ~1 minute on GPU. Set "
                "DIARIZATION_DEVICE=cuda on a GPU host.",
                flush=True,
            )
    return _pipeline


def require_auth(creds: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> None:
    # When no key is configured (e.g. local dev) auth is disabled, mirroring how the
    # Next.js provider sends no Authorization header if DIARIZATION_API_KEY is unset.
    if not API_KEY:
        return
    if creds is None or creds.credentials != API_KEY:
        raise HTTPException(status_code=401, detail="Unauthorized")


# Job outcomes. Diarization is the slowest and least predictable step in the
# pipeline, and it fails in ways users only notice much later (missing or wrong
# speaker labels), so failures are counted separately from successes and split by
# cause: `invalid_audio` is a bad or undecodable upload (the client's problem),
# `internal_error` is ours. `failure_reason` is empty on success — a label has to be
# present on every sample of a series, so it cannot simply be omitted.
diarization_jobs_total = Counter(
    "memoctopus_diarization_jobs_total",
    "Diarization job outcomes",
    ["status", "failure_reason"],
)

# Wall time of the work itself — decode plus inference, excluding both the upload and
# time spent queued behind another request. Separating these three is the point: the
# HTTP duration the instrumentator records includes upload (slow link), this includes
# neither (slow GPU), and the queue histogram below covers the rest (saturated
# service). Without the split, a #84-style timeout looks the same in all three cases.
# Only successful jobs are observed: a decode that fails in 50 ms would otherwise drag
# the percentiles down exactly when failures spike.
# Buckets run to 30 min because CPU-bound hosts genuinely take that long on a meeting.
_BUCKETS = (1, 5, 15, 30, 60, 120, 300, 600, 900, 1800, float("inf"))

diarization_duration_seconds = Histogram(
    "memoctopus_diarization_duration_seconds",
    "Decode + inference time for one successfully diarized recording",
    buckets=_BUCKETS,
)

# Time waiting for _inference_lock. The pipeline is not concurrency-safe, so requests
# serialise here; when this grows the service needs another replica, not a faster GPU.
diarization_queue_wait_seconds = Histogram(
    "memoctopus_diarization_queue_wait_seconds",
    "Time a request spent waiting for the inference lock",
    buckets=_BUCKETS,
)

# Standard per-route request count / duration / in-progress series, plus /metrics.
Instrumentator().instrument(app).expose(
    app,
    dependencies=[Depends(require_auth)] if METRICS_REQUIRE_AUTH else None,
)


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

    Decoded with the stdlib `wave` module so pyannote gets an in-memory waveform.
    This sidesteps pyannote 4's file I/O (torchcodec/ffmpeg), which isn't reliably
    available on every host.
    """
    with wave.open(io.BytesIO(data), "rb") as w:
        n_channels = w.getnchannels()
        sample_rate = w.getframerate()
        sample_width = w.getsampwidth()
        frames = w.readframes(w.getnframes())

    if sample_width != 2:
        raise ValueError("Only 16-bit PCM WAV is supported by the stdlib decoder")

    samples = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if n_channels > 1:
        samples = samples.reshape(-1, n_channels).mean(axis=1)  # downmix to mono
    waveform = torch.from_numpy(samples).unsqueeze(0)  # (1, time)
    return waveform, sample_rate


def _load_with_ffmpeg(data: bytes) -> tuple[torch.Tensor, int]:
    """Decode any compressed format (webm/opus, mp3, m4a, …) via ffmpeg.

    Clients send the recording in its original compressed format — ~4-10x smaller
    than the PCM WAV the service used to require, which dominates request time when
    the audio travels through an SSH tunnel. ffmpeg resamples to 16 kHz mono s16le
    on stdout; diarization is acoustic, so the resample is lossless for its purposes.
    """
    try:
        proc = subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-i", "pipe:0",
             "-ar", "16000", "-ac", "1", "-f", "s16le", "pipe:1"],
            input=data, capture_output=True, check=True,
        )
    except FileNotFoundError:
        raise HTTPException(
            status_code=415,
            detail="ffmpeg not installed on the diarization host; only PCM WAV is accepted",
        )
    except subprocess.CalledProcessError as e:
        raise HTTPException(status_code=400, detail=f"Undecodable audio: {e.stderr.decode(errors='replace')[:500]}")

    samples = np.frombuffer(proc.stdout, dtype="<i2").astype(np.float32) / 32768.0
    waveform = torch.from_numpy(samples).unsqueeze(0)  # (1, time)
    return waveform, 16_000


def _load_audio(data: bytes) -> tuple[torch.Tensor, int]:
    """PCM WAV via the fast stdlib path, anything else via ffmpeg."""
    try:
        return _load_wav(data)
    except (wave.Error, EOFError, ValueError):
        return _load_with_ffmpeg(data)


@app.post("/diarize")
async def diarize(
    # The Next.js client (and the co-hosted hviske /diarize) use the field name
    # `file`; the legacy contract used `audio`. Accept either so the same client
    # works against both this standalone service and the co-hosted endpoint.
    file: UploadFile | None = File(None),
    audio: UploadFile | None = File(None),
    _: None = Depends(require_auth),
) -> dict:
    upload = file or audio
    if upload is None:
        diarization_jobs_total.labels(status="failure", failure_reason="invalid_audio").inc()
        raise HTTPException(status_code=422, detail="Missing audio file (field 'file' or 'audio')")
    data = await upload.read()
    if len(data) < 2_000:
        # Too small to contain speech. A successful job with nothing to report, not a
        # failure — the caller gets an empty turn list and merges nothing.
        diarization_jobs_total.labels(status="success", failure_reason="").inc()
        return {"turns": []}

    t0 = time.monotonic()
    try:
        # Decode + inference are CPU/GPU-bound and synchronous — run them off the event
        # loop so /health and concurrent requests aren't frozen for minutes per file.
        waveform, sample_rate = await asyncio.to_thread(_load_audio, data)
        decoded_at = time.monotonic()
        async with _inference_lock:
            inference_started = time.monotonic()
            output = await asyncio.to_thread(get_pipeline(), {"waveform": waveform, "sample_rate": sample_rate})
            inference_ended = time.monotonic()
        annotation = _annotation_from(output)
        # Inside the try: _annotation_from raises when pyannote's output shape drifts,
        # and itertracks can raise for the same reason. Counting those as failures is
        # the whole point of the metric.
        turns = [
            {"speaker": speaker, "start": round(float(segment.start), 3), "end": round(float(segment.end), 3)}
            for segment, _, speaker in annotation.itertracks(yield_label=True)
        ]
    except HTTPException as e:
        # 400 is the only genuinely client-caused status raised below: undecodable
        # audio. 415 means ffmpeg is missing from the *host* — a misconfiguration that
        # would otherwise show up as 100% "bad uploads" and send operators hunting the
        # caller instead of the box.
        reason = "invalid_audio" if e.status_code == 400 else "internal_error"
        diarization_jobs_total.labels(status="failure", failure_reason=reason).inc()
        raise
    except Exception:
        diarization_jobs_total.labels(status="failure", failure_reason="internal_error").inc()
        raise

    diarization_queue_wait_seconds.observe(inference_started - decoded_at)
    diarization_duration_seconds.observe(
        (decoded_at - t0) + (inference_ended - inference_started)
    )
    print(
        f"[diarization] {len(data)} bytes ({waveform.shape[1] / sample_rate:.0f} s audio) "
        f"on {DEVICE} in {time.monotonic() - t0:.1f} s",
        flush=True,
    )

    turns.sort(key=lambda t: t["start"])
    diarization_jobs_total.labels(status="success", failure_reason="").inc()
    return {"turns": turns}
