# Deploying Referat

The deployment is **two compose files** so the app and the GPU services have
independent lifecycles and the whole thing is portable across servers (move =
clone repo → edit `.env` → `compose up`).

| File | Contains | Needs a GPU? |
|---|---|---|
| `docker-compose.yml` | **base ("small")**: app, bot-service, Postgres, migrate | no |
| `docker-compose.ai.yml` | **AI overlay**: hviske (vLLM STT) + diarization, and repoints the app at them | yes |

The overlay is **not standalone** — it's always merged on top of the base.

## Two deploy modes

```bash
cp .env.deploy.example .env        # then fill in the values
```

### "small" — app only (AI runs on another host)
Point `HVISKE_URL` / `DIARIZATION_URL` in `.env` at the remote GPU box, then:
```bash
docker compose up -d
```
Runs on any machine with Docker (no GPU needed).

### "everything" — the whole system on one GPU box
Requires Docker **+ NVIDIA driver + nvidia-container-toolkit**. The overlay
overrides `HVISKE_URL` / `DIARIZATION_URL` to the in-compose services, so you can
leave them blank in `.env`. Set `HF_TOKEN` if the model weights are gated.
```bash
docker compose -f docker-compose.yml -f docker-compose.ai.yml up -d
```
First boot is slow: hviske downloads the model into VRAM and diarization's image
build fetches the pyannote weights. The `hf-cache` volume makes later restarts fast.

> Tip: export `COMPOSE_FILE=docker-compose.yml:docker-compose.ai.yml` once and then
> plain `docker compose up -d` / `logs` / `ps` always include the overlay.

## Day-2 operations

```bash
# Redeploy ONLY the frontend (GPU models untouched):
docker compose up -d --build app

# Logs / status for a service:
docker compose logs -f hviske
docker compose ps

# Tear down (keeps named volumes / data):
docker compose -f docker-compose.yml -f docker-compose.ai.yml down
```

## Verify a deployment is healthy

1. `docker compose ps` → all services `healthy` (`migrate` shows `Exited (0)`).
2. `docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi` → GPU visible (everything mode).
3. App health: `curl http://localhost:${APP_PORT:-8080}/api/health` → `{"status":"ok"}`.
4. From inside the app container, the AI services resolve:
   `docker compose exec app wget -qO- http://hviske:8000/v1/models`
   `docker compose exec app wget -qO- http://diarization-service:5000/health`
5. Auth + DB roundtrip: sign up a user, confirm it lands in Postgres
   (`docker compose exec db psql -U referat -d referat -c 'select email from public.users;'`).

## Prerequisite: a Docker-capable GPU host

The "everything" mode needs a host where Docker can access the GPU. An
**unprivileged container instance (e.g. vast.ai container mode) cannot run Docker** —
use a VM / bare-metal GPU host with `nvidia-container-toolkit` for that mode. The
"small" mode runs anywhere and can point at an external hviske/diarization.
