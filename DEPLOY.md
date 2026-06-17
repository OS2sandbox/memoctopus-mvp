# Deploying Referat

The deployment is **two compose files** so the app and the GPU services have
independent lifecycles and the whole thing is portable across servers (move =
clone repo → edit `.env` → `compose up`).

| File | Contains | Needs a GPU? |
|---|---|---|
| `docker-compose.yml` | **base ("small")**: app, bot-service, Postgres, migrate | no |
| `docker-compose.ai.yml` | **AI overlay**: hviske (vLLM STT) + diarization, and repoints the app at them | yes |

The overlay is **not standalone** — it's always merged on top of the base.

## One-command host setup

On a fresh Ubuntu/Debian GPU host, `scripts/bootstrap-host.sh` installs Docker +
the NVIDIA Container Toolkit, verifies `--gpus all`, and brings the stack up:

```bash
git clone <repo> referat && cd referat
./scripts/bootstrap-host.sh            # everything mode: install + verify GPU + up
./scripts/bootstrap-host.sh --small    # app stack only (no GPU toolkit)
./scripts/bootstrap-host.sh --no-up    # install + verify, don't start
```
On first run with no `.env` it creates one from the template and stops so you can
fill in secrets; re-run to bring the stack up. It assumes the NVIDIA *driver* is
already installed (`nvidia-smi` works) — it does not install kernel drivers.

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

### Test the small stack locally against the GPU server

Run the small stack on your laptop while transcription/diarization/OpenAI run
remotely — all chosen via env. In `.env`:

```bash
HVISKE_URL=http://<GPU-HOST>:40093/v1     # hviske is published publicly
HVISKE_API_KEY=<key>
OPENAI_API_KEY=<key>
# diarization is bound to 127.0.0.1:5000 on the box → reach it through an SSH
# tunnel on the host; the app container hits it via host.docker.internal:
DIARIZATION_URL=http://host.docker.internal:5001
DIARIZATION_API_KEY=<key>
```

Open the tunnel (leave it running). Use a **local port other than 5000 on macOS**
— AirPlay Receiver squats :5000; we use :5001. Bind `0.0.0.0` so the container can
reach it via `host.docker.internal`:

```bash
ssh -p <ssh-port> -N -L 0.0.0.0:5001:localhost:5000 <user>@<GPU-HOST>
docker compose up -d        # app on http://localhost:8080
```

The `app` service already declares `extra_hosts: host.docker.internal:host-gateway`
so this works on Linux hosts too (automatic on Docker Desktop). Verify:
`docker compose exec app wget -qO- http://host.docker.internal:5001/health`.

## Reusing pre-downloaded model weights

By default hviske downloads its (public) model into a named volume on first boot,
and diarization bakes its (gated) weights into the image at build. To avoid
re-downloading multi-GB weights on a new host, reuse an existing HF cache:

- **hviske**: set `HF_CACHE_DIR` in `.env` to a host path containing an HF cache
  (e.g. `/workspace/.hf_home`). It bind-mounts that instead of the named volume.
- **diarization**: weights live at `/models` on a named volume that Docker seeds
  from the baked image on first start (default just works). To reuse a host cache,
  set `DIAR_HF_CACHE_DIR` to that path (bind mount); pair with
  `DIARIZATION_BAKE_WEIGHTS=false` to also skip the build-time download.

Models used: `syvai/hviske-v5.1` (public, no token) and
`pyannote/speaker-diarization-community-1` (gated — needs an `HF_TOKEN` whose
account accepted the terms once; access is auto-granted).

## Day-2 operations

> These `docker compose` commands need docker-group membership (the bootstrap
> script adds you — log out/in once) or `sudo`.

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
