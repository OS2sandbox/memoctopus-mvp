# diarization-service

Self-hosted speaker diarization for Referat. A small FastAPI service wrapping
[pyannote.audio](https://github.com/pyannote/pyannote-audio) 4.0
(`speaker-diarization-community-1`, CC-BY-4.0).

The Danish STT model (hviske) does not diarize, so this runs as a separate
**acoustic** pass over the full recording and returns speaker turns. The Next.js
app merges those turns onto the transcript by time-overlap
(`src/lib/audio/merge-speakers.ts`). Diarization is language-agnostic.

The app sends the recording in its **original compressed format** (webm/opus,
mp3, m4a, …) — ~4-10x smaller than PCM WAV, which matters because requests
travel through an SSH tunnel. PCM WAV is decoded in-process (stdlib `wave` +
numpy); everything else is decoded by shelling out to **ffmpeg** (`ffmpeg` must
be on PATH — it is in the Docker image; install it on bare-metal hosts with
`apt-get install -y ffmpeg`). Neither path depends on pyannote 4's
torchcodec/ffmpeg audio backend.

## API

- `GET /health` → `{ "status": "ok", "model": "...", "device": "cuda" }`
- `POST /diarize` (multipart, field `file` — `audio` also accepted for the legacy contract) → `{ "turns": [{ "speaker": "SPEAKER_00", "start": 0.0, "end": 4.2 }, ...] }`
  - Bearer-authenticated with `DIARIZATION_API_KEY` (auth disabled when unset).
- `GET /metrics` → Prometheus exposition format.
  - Standard per-route series (`http_requests_total`, `http_request_duration_seconds`,
    in-progress) from `prometheus-fastapi-instrumentator`, plus:
  - `memoctopus_diarization_jobs_total{status,failure_reason}` — job outcomes.
    `failure_reason` is `invalid_audio` (bad or undecodable upload) or
    `internal_error`, and empty on success. All three series exist at zero from
    startup, so failure-ratio alerts work before the first failure.
  - `memoctopus_diarization_duration_seconds` — decode + inference wall time,
    excluding upload and queueing. Compare against the HTTP duration to tell a slow
    link from a slow GPU. Observed for successful jobs only.
  - `memoctopus_diarization_queue_wait_seconds` — time spent waiting for the inference
    lock. The pipeline is not concurrency-safe, so requests serialise; when this grows
    the service needs another replica, not a faster GPU.
  - Unauthenticated by default; see `DIARIZATION_METRICS_REQUIRE_AUTH` and
    "Reaching `/metrics`" below.

  What `memoctopus_diarization_jobs_total` does **not** count, so it will not reconcile
  exactly with `http_requests_total{handler="/diarize"}`:
  - Requests rejected before the handler runs: a wrong or missing bearer token (401) and
    a malformed multipart body (400).
  - Uploads under about 2 KB are counted as `success` with no turns. They are too small
    to contain speech, and the caller merges nothing. They add nothing to the duration
    histograms.
  - Client timeouts (for example the app's `DIARIZATION_TIMEOUT_MS`, see #84) are not
    visible here. A job is only counted when the handler reaches its end or raises, so what
    is recorded for a request the client abandoned depends on the server. Watch the app's
    `[diarize] failed after …` log lines for those.

## Config (env)

- `DIARIZATION_API_KEY` — bearer secret; must match the app's `DIARIZATION_API_KEY`.
- `DIARIZATION_DEVICE` — `cpu` | `cuda` | unset (auto). Force `cpu` only if the GPU
  is saturated by another model — CPU is 10-20x slower and the service logs a loud
  warning at startup when it is not on `cuda`.
- `DIARIZATION_SEGMENTATION_BATCH_SIZE` / `DIARIZATION_EMBEDDING_BATCH_SIZE` —
  sub-model batch sizes (default 32). Larger values cut GPU inference wall time on
  long recordings; lower them if VRAM is tight.
- `DIARIZATION_METRICS_REQUIRE_AUTH` — `1`, `true` or `yes` to require the same bearer
  token on `/metrics` as on `/diarize`. Off by default: the service is not publicly exposed, and
  a scraper that suddenly needs a credential fails silently (the series just stop). Turn
  it on where the service is reachable from outside the internal network. Like
  `/diarize`, it has no effect unless `DIARIZATION_API_KEY` is also set — with no key
  configured there is nothing to check and `/metrics` stays open (the service logs a
  warning at startup when the flag is set without a key).
- `HF_TOKEN` — only needed the first time, to download the gated weights (cached after).

## Reaching `/metrics`

Who can read `/metrics` depends on how the service is deployed:

- **Deploy A** binds `127.0.0.1:5000`, so `/metrics` is reachable only from the box itself
  or through the SSH tunnel the app already uses. To scrape it, run Prometheus (or the
  Grafana Agent) on the box, or forward the port: `ssh -L 5000:localhost:5000 <box>` and
  scrape `localhost:5000/metrics`. No extra setting is needed.
- **Deploy B and `deploy.sh`** publish port 5000 on every interface (`-p 5000:5000`). There
  `/metrics` is as open as `/health` and `/docs`: it exposes request counts, latencies and
  job outcomes, but no filenames, sizes or audio. Either publish on loopback
  (`-p 127.0.0.1:5000:5000`) or set `DIARIZATION_API_KEY` together with
  `DIARIZATION_METRICS_REQUIRE_AUTH=true` and give the scraper the bearer token.

## Deploy A — directly on the GPU box (what production uses)

This is how it's deployed next to the hviske vLLM server (a vast.ai box, no Docker):

```bash
# Install from requirements.txt, not just pyannote: app.py imports the Prometheus
# packages at module load, so a partial install crash-loops the service under
# supervisord rather than degrading.
pip3 install -r requirements.txt
# one-time gated-model download (accept terms on huggingface.co first):
HF_TOKEN=hf_xxx python3 -c "from pyannote.audio import Pipeline; \
  Pipeline.from_pretrained('pyannote/speaker-diarization-community-1')"
DIARIZATION_API_KEY=secret DIARIZATION_DEVICE=cuda \
  uvicorn app:app --host 127.0.0.1 --port 5000
```

Kept alive by **supervisord** (`/etc/supervisor/conf.d/diarization.conf` →
`/root/start_diarization.sh`), so it auto-restarts on crash/reboot. The app
reaches it over an SSH tunnel (`scripts/diar-tunnel.sh`, `DIARIZATION_URL` +
`DIARIZATION_SSH` in `.env`).

**GPU memory:** pyannote needs ~1–2 GB. If an STT server (vLLM) holds the card,
free room by lowering its `--gpu-memory-utilization` (e.g. 0.9 → 0.78 frees ~3 GB
with negligible ASR impact), or run diarization on CPU (`DIARIZATION_DEVICE=cpu`).

## Deploy B — Docker (for hosts with nvidia-container-toolkit)

```bash
docker build --build-arg HF_TOKEN=hf_xxx -t diarization-service .
docker run --gpus all -p 5000:5000 -e DIARIZATION_API_KEY=secret diarization-service
```

Also wired in `docker-compose.yml` as the `diarization-service` service.

## Tests

`tests/` covers the metrics and their access control. It stubs `torch` and `pyannote`, so
no GPU or model download is needed. Python 3.10+ is required (the service uses
`X | None` annotations at runtime):

```bash
pip install fastapi python-multipart prometheus-fastapi-instrumentator numpy httpx pytest
pytest diarization-service/tests
```

## Smoke test

```bash
curl -F audio=@multi-speaker.wav -H "Authorization: Bearer secret" \
  http://localhost:5000/diarize
```
