# diarization-service

Self-hosted speaker diarization for Referat. A small FastAPI service wrapping
[pyannote.audio](https://github.com/pyannote/pyannote-audio) 4.0
(`speaker-diarization-community-1`, CC-BY-4.0).

The Danish STT model (hviske) does not diarize, so this runs as a separate
**acoustic** pass over the full recording and returns speaker turns. The Next.js
app merges those turns onto the transcript by time-overlap
(`src/lib/audio/merge-speakers.ts`). Diarization is language-agnostic.

The app always sends a 16 kHz mono PCM WAV, which the service decodes in-process
(stdlib `wave` + numpy) and hands to pyannote as a waveform tensor — so it does
**not** depend on pyannote 4's torchcodec/ffmpeg audio backend.

## API

- `GET /health` → `{ "status": "ok", "model": "...", "device": "cuda" }`
- `POST /diarize` (multipart, field `audio`) → `{ "turns": [{ "speaker": "SPEAKER_00", "start": 0.0, "end": 4.2 }, ...] }`
  - Bearer-authenticated with `DIARIZATION_API_KEY` (auth disabled when unset).

## Config (env)

- `DIARIZATION_API_KEY` — bearer secret; must match the app's `DIARIZATION_API_KEY`.
- `DIARIZATION_DEVICE` — `cpu` | `cuda` | unset (auto). Force `cpu` if the GPU is
  already saturated by another model.
- `HF_TOKEN` — only needed the first time, to download the gated weights (cached after).

## Deploy A — directly on the GPU box (what production uses)

This is how it's deployed next to the hviske vLLM server (a vast.ai box, no Docker):

```bash
pip3 install pyannote.audio
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

## Smoke test

```bash
curl -F audio=@multi-speaker.wav -H "Authorization: Bearer secret" \
  http://localhost:5000/diarize
```
