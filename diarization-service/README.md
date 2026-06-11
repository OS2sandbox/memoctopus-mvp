# diarization-service

Self-hosted speaker diarization for Referat. A small FastAPI service wrapping
[pyannote.audio](https://github.com/pyannote/pyannote-audio) 4.0
(`speaker-diarization-community-1`, CC-BY-4.0).

The Danish STT model (hviske) does not diarize, so this runs as a separate
**acoustic** pass over the full recording and returns speaker turns. The Next.js
app merges those turns onto the transcript by time-overlap
(`src/lib/audio/merge-speakers.ts`). Diarization is language-agnostic.

## API

- `GET /health` → `{ "status": "ok", "model": "...", "cuda": true }`
- `POST /diarize` (multipart, field `audio`) → `{ "turns": [{ "speaker": "SPEAKER_00", "start": 0.0, "end": 4.2 }, ...] }`
  - Bearer-authenticated with `DIARIZATION_API_KEY` (auth disabled when unset).

## Build

The model weights are **gated** on Hugging Face. First accept the terms for
`pyannote/speaker-diarization-community-1` and its segmentation dependency on
huggingface.co, then bake the weights into the image so the service runs offline:

```bash
docker build --build-arg HF_TOKEN=hf_xxx -t diarization-service .
```

## Run

Requires an NVIDIA GPU (`nvidia-container-toolkit`); falls back to CPU (slow) otherwise.

```bash
docker run --gpus all -p 5000:5000 -e DIARIZATION_API_KEY=secret diarization-service
```

In production it is wired via `docker-compose.yml` as the `diarization-service`
service and reached by the app at `http://diarization-service:5000`.

## Smoke test

```bash
curl -F audio=@multi-speaker.wav -H "Authorization: Bearer secret" \
  http://localhost:5000/diarize
```
