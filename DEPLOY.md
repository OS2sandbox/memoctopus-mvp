# Deploying Referat

The deployment is **two compose files** so the app and the GPU services have
independent lifecycles and the whole thing is portable across servers (move =
clone repo → edit `.env` → `compose up`).

| File | Contains | Needs a GPU? |
|---|---|---|
| `docker-compose.yml` | **base ("small")**: app, Postgres, migrate | no |
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

## Microsoft login and Teams referater

Microsoft Entra ID is configured separately from the generic OIDC provider below,
because it does double duty: it signs users in **and** it is how Memoctopus reaches
Microsoft Graph to collect Teams transcripts. Like all auth configuration it is read
at runtime — `docker compose up -d app` is enough, no `--build`.

Microsoft login enables itself as soon as `MICROSOFT_CLIENT_ID` and
`MICROSOFT_CLIENT_SECRET` are set; `MICROSOFT_ENABLED=false` is a kill switch.

1. In **Entra admin center → App registrations**, register this redirect URI as
   type *Web*:

   ```
   <BETTER_AUTH_URL>/api/auth/callback/microsoft
   ```

   Entra permits plain `http` only for `localhost`, so a real deployment must be
   on https. `BETTER_AUTH_URL` is the single source of truth for the app's own
   URLs — nothing is derived from request headers, so a mismatch here breaks
   OAuth silently.

2. Fill in `.env`:

   ```bash
   MICROSOFT_CLIENT_ID=...
   MICROSOFT_CLIENT_SECRET=...
   MICROSOFT_TENANT_ID=...        # the customer's real tenant id
   ```

   **⚠️ Set the real tenant id.** Left blank it falls back to `common`
   (multi-tenant): sign-in then accepts users from any tenant. Admin consent is
   granted per tenant and covers only that tenant's users, so a blank id does not
   make it "not apply" — it just leaves users from other tenants unconsented.

3. Teams referater are **off by default**. To use them, first give the same app
   registration these **delegated** Microsoft Graph permissions with **admin
   consent granted** for the organisation, and only then set
   `TEAMS_GRAPH_ENABLED=true` (see the warning below). All three are scoped to individual meetings the user is already
   party to — no calendar or mailbox access is requested:

   | Permission | Used for |
   |---|---|
   | `OnlineMeetings.ReadWrite` | Turning on automatic transcription per meeting |
   | `OnlineMeetingTranscript.Read.All` | Fetching the transcript afterwards |
   | `OnlineMeetingRecording.Read.All` | Fetching the recording afterwards |
   | `User.Read`, `offline_access` | Identity, and refreshing access without re-login |

   `OnlineMeetingRecording.Read.All` is the widest of the three (the video of every
   meeting the user can reach). With `TEAMS_ARTIFACT_MODE=transcript-only` it is
   neither requested nor needed, so leave it out of the registration.

   Delegated means the app never sees more than the signed-in user can see — only
   that user's own meetings. Without admin consent each user is prompted
   individually, which most municipal users cannot approve themselves.

4. In **Teams admin center → Meetings → Meeting policies**, set *Transcription*
   and *Meeting recording* to **On**. Both are required; without them Graph
   accepts the request but Teams ignores it, and the app reports
   `policy_blocked`. Allow up to an hour for the policy to propagate.

The full admin guide, written in Danish for the customer's own IT department, ships
with the app at `public/docs/setup-microsoft-teams.md` and is linked from the error
screens.

**⚠️ Grant admin consent before you set `TEAMS_GRAPH_ENABLED=true`.** The flag makes
every Microsoft sign-in request the Graph permissions above. The two `*.Read.All`
ones need tenant-admin consent; a tenant that has not granted it answers *"Need
admin approval"* to the whole sign-in, so **no one** in that tenant can log in with
Microsoft, for any feature. Consent is **per tenant**: granting it in one tenant
does nothing for another. If the tenant's admin-consent request workflow is off,
there is not even a way for users to ask. With the flag unset (the default) sign-in
asks for nothing beyond the normal login scopes and the Teams features stay hidden.

The flag is read once at startup, so **restart** the app after changing it
(`docker compose up -d app` is enough, no `--build`). `TEAMS_ARTIFACT_MODE` is
read the same way for the sign-in scopes, so restart after changing that too.

**Existing users must sign in again.** Consented scopes are stored per account at
login, so users who signed in before step 3 keep a token with the old scope list.
The dashboard shows them a "Giv adgang igen" button until they re-authenticate;
this is expected, not a fault.

**OAuth tokens are encrypted at rest.** The access and refresh tokens in the
`accounts` table are encrypted with `BETTER_AUTH_SECRET` (once Teams is on, the
refresh token reaches meeting transcripts and recordings). Rows written before this
keep working and are encrypted the next time the user signs in or a token is
refreshed. **Rotating `BETTER_AUTH_SECRET` makes the stored tokens unreadable**:
those users have to sign in with Microsoft again.

Behaviour is tuned with the `TEAMS_*` variables in `.env.deploy.example`. The one
worth a deliberate decision is `TEAMS_ARTIFACT_MODE`: `prefer-recording` (default)
downloads the Teams recording and re-transcribes it locally with hviske, while
`transcript-only` uses Teams' own text transcript, never downloads audio and never
asks for the recording permission — the right choice for a customer who does not
want meeting audio at rest here.

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
