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

## Single sign-on (OIDC)

Memoctopus can sign users in against any standards-compliant OIDC provider —
Keycloak, Authentik, Entra ID via OIDC, and so on. There is no provider-specific
code: you supply a discovery URL, a client id and a client secret.

**Auth configuration is read at runtime.** Change it and `docker compose up -d app`
is enough — you never need `--build` for a login-method change.

1. In your IdP, create a **confidential** client (client id + secret) and register
   this redirect URI, substituting your own values:

   ```
   <BETTER_AUTH_URL>/api/auth/oauth2/callback/<OIDC_PROVIDER_ID>
   ```

2. Find the discovery document:

   | IdP | Discovery URL |
   |---|---|
   | Keycloak | `https://<host>/realms/<realm>/.well-known/openid-configuration` |
   | Authentik | `https://<host>/application/o/<app-slug>/.well-known/openid-configuration` |

3. Fill in `.env`:

   ```bash
   OIDC_PROVIDER_ID=keycloak            # also the callback path segment
   OIDC_PROVIDER_NAME=Kommune Login     # button label: "Fortsæt med Kommune Login"
   OIDC_CLIENT_ID=...
   OIDC_CLIENT_SECRET=...
   OIDC_DISCOVERY_URL=https://.../.well-known/openid-configuration
   ```

4. `docker compose up -d app`, then load the sign-in page — the button appears as
   soon as all three credentials are set. Scopes are always `openid profile email`;
   PKCE is on unless you set `OIDC_PKCE=false`.

To offer SSO only, set `EMAIL_PASSWORD_ENABLED=false`; that disables the
email/password endpoints, not just the form.

**⚠️ Pick `OIDC_PROVIDER_ID` once.** It is both the callback path segment and the
key linking users to their accounts. Changing it after go-live means returning
users no longer match their existing account and are given a new, empty one.

**Account linking.** An SSO login links into an existing account with the same
email only when **both** sides are verified: your IdP must assert `email_verified`
for the incoming login, and the existing account must already be verified. This
app sends no verification emails, so accounts created with email/password are
never linkable — if such a user later signs in via SSO they get "account not
linked". Have them sign in the way they registered, or remove the password
account first.

This is deliberate and should not be relaxed by marking providers trusted: that
would drop the check on the *incoming* IdP, so anyone able to self-register at a
configured IdP under someone else's address could take over their account — and
each account owns a private PostgreSQL schema.

**Upgrading from the Authentik-specific setup.** `AUTHENTIK_CLIENT_ID`,
`AUTHENTIK_CLIENT_SECRET` and `AUTHENTIK_DISCOVERY_URL` still work and log a
deprecation warning; on that path the provider id stays `authentik`, so your
registered redirect URI and existing accounts are unaffected. To migrate, copy the
three values to their `OIDC_*` names and set `OIDC_PROVIDER_ID=authentik`.

## Municipal installation: own IdP, roles from claims (OIDC and SAML)

Each municipality or region runs its own installation against its own identity provider
(FKA, Entra ID, OS2faktor, Authentik, ...). Which providers exist, how users and roles are
read from the IdP's answer, and which claim value means which app role is described in **one
JSON file per installation** — no code change, no rebuild, nothing shared with other
installations. The full format and one recipe per IdP is in
[`docs/central-access/idp.md`](docs/central-access/idp.md). In short:

1. Put `auth.json` (and any SAML metadata XML it points at) in a directory on the host, by
   default `./auth-config` next to `docker-compose.yml` (`AUTH_CONFIG_DIR`). It is mounted
   read-only at `/config` and is git-ignored, because it may hold client secrets. Prefer
   `"clientSecret": "${MY_IDP_SECRET}"` in the file and the secret in `.env`; for the app to
   see it, forward the variable in a `docker-compose.override.yml`:

   ```yaml
   services:
     app:
       environment:
         - MY_IDP_SECRET=${MY_IDP_SECRET}
   ```

2. In `.env`:

   ```bash
   AUTH_CONFIG_FILE=/config/auth.json
   ACCESS_SOURCE=claims              # roles come from the IdP's claims, not from the app
   EMAIL_PASSWORD_ENABLED=false      # a password account has no role; do not offer it
   REQUIRE_ROLE_TO_LOGIN=true        # no role claim, no access
   # ROLE_CLAIMS_MAX_SECONDS=28800   # how long a login's roles count; sessions end with it
   ```

3. Register with the IdP, with `BETTER_AUTH_URL` as the public URL of the app:

   | Protocol | What the IdP is given |
   |---|---|
   | OIDC | redirect URI `<BETTER_AUTH_URL>/api/auth/oauth2/callback/<provider id>` |
   | SAML 2.0 | ACS URL (HTTP-POST) `<BETTER_AUTH_URL>/api/auth/sso/saml2/sp/acs/<provider id>`; SP metadata at `<BETTER_AUTH_URL>/api/auth/sso/saml2/sp/metadata?providerId=<provider id>`; entity id = that metadata URL unless `spEntityId` is set |

4. `docker compose up -d app`. The file is read once at start, so a change needs this
   restart. A provider with an invalid entry is skipped with a content-free warning in the
   log (`[auth] Ignoring providers[2]: ...`); an invalid `roles` section grants **nobody** a
   role (fail closed) and is reported the same way.

Rights and administrator assignment happen **outside** the app: removing a person's role
in the IdP removes it here at their next login (and at the latest when
`ROLE_CLAIMS_MAX_SECONDS` has passed, after which the session has ended too). The
in-app role administration is switched off in claims mode, and there is no in-app
administrator to lock out, so keep a **break-glass path on the IdP side** (a documented
account that carries the administrator claim). A password sign-up can never be a way around
this: password accounts get no roles. The in-app admin (`ACCESS_SOURCE=local`) stays for
development and demos and can be turned off with `ACCESS_LOCAL_ADMIN=false`.

**Not supported (ask the client before promising them):** RP-initiated logout / OIDC
back-channel logout and SAML single logout (signing out of the app does not sign out of the
IdP), encrypted SAML assertions, Entra group overage (use app roles instead of `groups`),
and removing a role in the IdP taking effect inside a still-running session before
`ROLE_CLAIMS_MAX_SECONDS` (the IdP is only asked at login).

## Central access, audit log and Rollekatalog

- **PostgreSQL 15 or newer** (the migrations use `NULLS NOT DISTINCT`); the compose file runs `postgres:16-alpine`. Migrations `0001` to `0004` run in the `migrate` service like the others.
- **Set first** (all in `.env.example`; runtime only, restart without rebuild): `ACCESS_SOURCE` (`local` by default, or `rollekatalog`, or `claims`; a typo makes access control answer 503), `BOOTSTRAP_ADMIN_EMAILS`, `INTERNAL_CRON_SECRET`, and `AUDIT_RETENTION_DAYS` (default 365 days; `forever` keeps the log, see `docs/central-access/audit.md`). Rollekatalog variables are only needed for `ACCESS_SOURCE=rollekatalog`, except that the optional **role catalogue** (the roles and groups a shared prompt can be made available to) needs only `ROLLEKATALOG_URL` and `ROLLEKATALOG_READ_API_KEY`, in any mode (`ROLLEKATALOG_ROLES_PATH` / `ROLLEKATALOG_ROLEGROUPS_PATH` override its unverified default endpoints; section 12 of `docs/central-access/rollekatalog.md`). Without Rollekatalog the catalogue comes from the `catalogue` section of `AUTH_CONFIG_FILE`. If you set `DIRECTORY_USERID_TRANSFORM=strip-upn-domain`, also set `DIRECTORY_USERID_DOMAIN` (your UPN domain, for example `kommune.dk`); without it no login is matched (see `docs/central-access/rollekatalog.md`).
- **First administrator.** In local mode, list your address in `BOOTSTRAP_ADMIN_EMAILS` and sign in through SSO (Microsoft needs a single-tenant `MICROSOFT_TENANT_ID`; OIDC needs `email_verified`). It grants `tt-administrator` once; the flag `bootstrap_admin_done` in `public.system_flags` then disables it. Recovery after a lock-out: `DELETE FROM system_flags WHERE key = 'bootstrap_admin_done';` and sign in again, or insert a `role_assignments` row by SQL.
- **Scheduling.** Nothing in the app runs timers. Call the routes from a host or cluster cron with `X-Cron-Secret`; both answer 404 until `INTERNAL_CRON_SECRET` is set, and the sync answers 409 unless `ACCESS_SOURCE=rollekatalog` and the integration is configured:

  ```
  15 3 * * *    curl -fsS -X POST -H "X-Cron-Secret: $INTERNAL_CRON_SECRET" http://localhost:8080/api/internal/audit/prune -o /dev/null
  */15 * * * *  curl -fsS -m 600 -X POST -H "X-Cron-Secret: $INTERNAL_CRON_SECRET" http://localhost:8080/api/internal/rollekatalog/sync -o /dev/null
  30 3 * * *    curl -fsS -m 120 -X POST -H "X-Cron-Secret: $INTERNAL_CRON_SECRET" http://localhost:8080/api/internal/rollekatalog/roles -o /dev/null
  ```

  The last line refreshes the role catalogue (optional, any `ACCESS_SOURCE`; it answers 409 without a URL and READ key). The catalogue only ever deactivates entries, so a prompt that targets a withdrawn role keeps its reference; a refresh that would withdraw an unusually large share of the entries is refused (`removal_threshold`) and has to be forced from the admin button.
  (`8080` is the default `APP_PORT`.) Keep the sync interval well below `ROLE_STALE_MAX_SECONDS` (24 h by default).
- **Client IP and the `X-Forwarded-For` header.** The client IP stored in the audit log and used by the failed-login throttle is the **first** entry of `X-Forwarded-For` (`AUTH_IP_HEADERS`, default `x-forwarded-for`). The app trusts it as sent, so whatever sits in front must **overwrite** it with the real peer address; the shipped `nginx/nginx.conf` and `nginx-init.conf` set it to `$remote_addr`, and any other proxy must do the same. But `docker-compose.yml` publishes the app on **all host interfaces** (`${APP_PORT:-8080}:3000`): anyone who can reach that port directly can skip the proxy and send any `X-Forwarded-For`, forging the audit IP and sidestepping the per-IP failed-login cap. Whenever a proxy is in use, either bind the app to loopback with a compose override (do not edit the default in `docker-compose.yml`):

  ```yaml
  # docker-compose.override.yml
  services:
    app:
      ports: !override
        - "127.0.0.1:${APP_PORT:-8080}:3000"
  ```

  (`!override` needs Docker Compose 2.24 or newer; on older versions list the port in a separate overlay that replaces the `ports` key, or remove the publish and let the proxy reach `app:3000` over the Docker network), or firewall `APP_PORT` so only the proxy can reach it. The cron examples above call `http://localhost:8080` and keep working with the loopback binding, because they run on the host. With no proxy in front at all, the stored IP is simply whatever the client sends.
- **Docs.** `docs/central-access/README.md` (overview), `idp.md` (identity providers, SAML, roles from claims), `rollekatalog.md` (operator guide), `audit.md` (log, feed, retention), `templates.md` (central templates).

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
