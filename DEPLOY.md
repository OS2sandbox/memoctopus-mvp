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
On first run with no `.env` it creates one from `.env.example` and stops so you can
fill in secrets; re-run to bring the stack up. It assumes the NVIDIA *driver* is
already installed (`nvidia-smi` works) — it does not install kernel drivers.

## Two deploy modes

```bash
cp .env.example .env        # then fill in the values; see the "COMPOSE / DEPLOYMENT ONLY" block
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

**Automatic tunnel (recommended)** — merge the tunnel overlay and set
`DIARIZATION_SSH`; a sidecar opens and maintains the SSH tunnel as part of the
stack, and the overlay points the app at it (`http://diar-tunnel:5000`). No manual
`ssh -L`, no host port (so no macOS AirPlay :5000 clash), works on Linux too:

```bash
# in .env:  DIARIZATION_SSH=-p 40419 root@<GPU-HOST>
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d
```
The sidecar authenticates with a key from `~/.ssh` (override via `SSH_DIR`);
passphrase-protected keys need an ssh-agent (see `docker-compose.tunnel.yml`).
Verify: `docker compose ... ps` shows `diar-tunnel` healthy.

**Manual tunnel (alternative)** — if you'd rather not run the sidecar, open the
tunnel yourself and set `DIARIZATION_URL=http://host.docker.internal:5001` (use a
local port other than 5000 on macOS — AirPlay squats it; the `app` service
declares `extra_hosts: host.docker.internal:host-gateway` so this works on Linux):

```bash
ssh -p <ssh-port> -N -L 0.0.0.0:5001:localhost:5000 <user>@<GPU-HOST>
docker compose up -d
```

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

Models used: `syvai/hviske-ensemble` (public, no token) and
`pyannote/speaker-diarization-community-1` (gated — needs an `HF_TOKEN` whose
account accepted the terms once; access is auto-granted).

## Login, roles and audit: where the facts live

Nothing about login methods, roles or the audit log is repeated here. Each fact has one home:

| Topic | Single source |
|---|---|
| Every environment variable and its default | `.env.example` (one template for development and compose) |
| Identity providers (OIDC, Entra, SAML), `AUTH_CONFIG_FILE`, roles from claims, `ROLE_CLAIMS_MAX_SECONDS`, break-glass, shared workstations, what is not built, the legacy `OIDC_*` / `AUTHENTIK_*` variables | `docs/central-access/idp.md` |
| Rollekatalog connection, sync, role catalogue | `docs/central-access/rollekatalog.md` |
| Audit log, retention, client IP trust | `docs/central-access/audit.md` |
| Architecture, role table, the three `ACCESS_SOURCE` modes | `docs/central-access/README.md` |
| Central templates | `docs/central-access/templates.md` |

What a deployment has to set (all in `.env`, runtime only: edit, then `docker compose up -d app`, never `--build`):

- **`ACCESS_SOURCE`**: `local` (default; development and demos), `rollekatalog` or `claims` (the municipal setup). A typo makes access control answer 503; it never means `local`.
- **`AUTH_CONFIG_FILE=/config/auth.json`** for any real identity provider. The file lives in `AUTH_CONFIG_DIR` (default `./auth-config`, git-ignored, mounted read-only at `/config`); a `${NAME}` in it needs that variable forwarded to the `app` service in a `docker-compose.override.yml` (`idp.md` section 9). Register with the IdP using `BETTER_AUTH_URL` as the public URL (`idp.md` sections 5 and 6); in production it must be the **https** URL.
- **`BETTER_AUTH_URL`**, `BETTER_AUTH_SECRET` and the compose `DATABASE_URL`.
- **`INTERNAL_CRON_SECRET`** for the scheduled routes below.
- Claims mode is closed by default: password sign-in is always off there, and `REQUIRE_ROLE_TO_LOGIN` must stay **blank** (unset means "no mapped role, no access"). Do not give either a default in a compose override.
- `BOOTSTRAP_ADMIN_EMAILS` (local mode only; one-shot first administrator) and `AUDIT_RETENTION_DAYS` (default 365 days).
- Rollekatalog variables are needed for `ACCESS_SOURCE=rollekatalog`; the optional role catalogue needs only `ROLLEKATALOG_URL` and `ROLLEKATALOG_READ_API_KEY`, in any mode.

**PostgreSQL 15 or newer** is required (the migrations use `NULLS NOT DISTINCT`); the compose file runs `postgres:16-alpine`. Migrations run in the `migrate` service.

## Scheduling

Nothing in the app runs timers. Call the routes from a host or cluster cron with `X-Cron-Secret`; all answer 404 until `INTERNAL_CRON_SECRET` is set, and the Rollekatalog sync answers 409 unless `ACCESS_SOURCE=rollekatalog` and the integration is configured (`8080` is the default `APP_PORT`):

```
15 3 * * *    curl -fsS -X POST -H "X-Cron-Secret: $INTERNAL_CRON_SECRET" http://localhost:8080/api/internal/audit/prune -o /dev/null
*/30 * * * *  curl -fsS -X POST -H "X-Cron-Secret: $INTERNAL_CRON_SECRET" http://localhost:8080/api/internal/bot-audio/sweep -o /dev/null
*/15 * * * *  curl -fsS -m 600 -X POST -H "X-Cron-Secret: $INTERNAL_CRON_SECRET" http://localhost:8080/api/internal/rollekatalog/sync -o /dev/null
30 3 * * *    curl -fsS -m 120 -X POST -H "X-Cron-Secret: $INTERNAL_CRON_SECRET" http://localhost:8080/api/internal/rollekatalog/roles -o /dev/null
```

- `audit/prune` applies the retention (`audit.md`).
- `bot-audio/sweep` deletes Teams-bot recordings and transcripts nobody collected within an hour (each deletion is logged as `bot.audio_delete`, `ttl`); it is idempotent and is what makes the retention promise provable even when no new recording arrives to trigger the opportunistic sweep.
- `rollekatalog/sync` (only in `rollekatalog` mode): keep the interval well below `ROLE_STALE_MAX_SECONDS` (24 h by default).
- `rollekatalog/roles` refreshes the optional role catalogue (any `ACCESS_SOURCE`; 409 without a URL and READ key). It only ever deactivates entries; a refresh that would withdraw an unusually large share is refused (`removal_threshold`) and has to be forced from the admin button.

## Reverse proxy, client IP and the `X-Forwarded-For` header

The client IP stored in the audit log and used by the failed-login throttle is the **first** entry of `X-Forwarded-For` (`AUTH_IP_HEADERS`, default `x-forwarded-for`). The app trusts it as sent, so whatever sits in front must **overwrite** it with the real peer address; the shipped `nginx/nginx.conf` and `nginx-init.conf` set it to `$remote_addr`, and any other proxy must do the same.

- **The app port is published on all host interfaces** (`${APP_PORT:-8080}:3000`): anyone who can reach it directly can skip the proxy and send any `X-Forwarded-For`, forging the audit IP and sidestepping the per-IP failed-login cap. Whenever a proxy is in use, bind the app to loopback with a compose override (do not edit the default in `docker-compose.yml`):

  ```yaml
  # docker-compose.override.yml
  services:
    app:
      ports: !override
        - "127.0.0.1:${APP_PORT:-8080}:3000"
  ```

  (`!override` needs Docker Compose 2.24 or newer; on older versions list the port in a separate overlay that replaces the `ports` key, or remove the publish and let the proxy reach `app:3000` over the Docker network), or firewall `APP_PORT` so only the proxy can reach it. The cron examples above keep working with the loopback binding, because they run on the host. With no proxy in front at all, the stored IP is simply whatever the client sends.
- **Behind another load balancer or WAF.** The bundled nginx overwrites `X-Forwarded-For` with the address it sees (right for an edge proxy). If another proxy sits in front of it, nginx sees only that proxy, so the audit log and the throttle would record the proxy's address for everybody. Tell nginx to trust it: in `nginx/nginx.conf` add `set_real_ip_from <the load balancer's CIDR>;` and `real_ip_header X-Forwarded-For;` in the `server` block (see the comment there). Never trust a range you do not control.

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
5. Auth + DB roundtrip: sign in (in `local` / `rollekatalog` mode with e-mail/password you can sign up a test user; in claims mode use the IdP), confirm the user lands in Postgres
   (`docker compose exec db psql -U referat -d referat -c 'select email from public.users;'`).

## Prerequisite: a Docker-capable GPU host

The "everything" mode needs a host where Docker can access the GPU. An
**unprivileged container instance (e.g. vast.ai container mode) cannot run Docker** —
use a VM / bare-metal GPU host with `nvidia-container-toolkit` for that mode. The
"small" mode runs anywhere and can point at an external hviske/diarization.
