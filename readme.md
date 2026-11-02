# OS2taletiltekst

Next.js app for recording meetings, transcribing them and writing Danish referater
(meeting minutes). Speech-to-text is hviske-ensemble with pyannote speaker
diarization; chapters, PII detection and the referat itself come from a chat model —
hosted OpenAI, a self-hosted vLLM (the `docker-compose.ai.yml` overlay) or any
OpenAI-compatible endpoint. See DEPLOY.md for running it.

## Setup

1. `cp .env.example .env` and fill in the values.
2. `npm install`
3. `npm run db:migrate`
4. `npm run dev` — Next.js on port 3004, plus an SSH tunnel to a remote diarization
   service when `DIARIZATION_SSH` is set in `.env` (`scripts/diar-tunnel.sh`).

## Microsoft Teams (via Microsoft Graph)

Teams referater are **off by default**. Each organisation turns them on in its
own Microsoft 365 tenant, because Microsoft grants the permissions per tenant.
Do it in this order:

1. **Entra admin center:** on the app registration you use for Microsoft login,
   add the delegated Microsoft Graph permissions `OnlineMeetings.ReadWrite`,
   `OnlineMeetingTranscript.Read.All`, `OnlineMeetingRecording.Read.All`,
   `Files.ReadWrite`, `User.Read` and `offline_access`, then click
   **Grant admin consent**.
2. **Teams admin center:** in the meeting policy, set *Transcription* and
   *Meeting recording* to **On**. This can take up to an hour to apply.
3. **The server:** set `MICROSOFT_TENANT_ID` to the tenant's real id (not
   `common`), set `TEAMS_GRAPH_ENABLED=true`, and restart the app
   (`docker compose up -d app`).

> **Do step 1 before step 3.** With the flag on, every Microsoft sign-in asks for
> these permissions. A tenant that hasn't granted admin consent answers "Need
> admin approval", and then nobody in it can sign in with Microsoft at all.

By default, a meeting's recording is deleted from the organizer's OneDrive once it
has been transcribed. Set `TEAMS_DELETE_RECORDING=false` to keep it (then
`Files.ReadWrite` isn't needed).

More detail:

- [`public/docs/setup-microsoft-teams.md`](public/docs/setup-microsoft-teams.md):
  the step-by-step guide for the organisation's IT admin (in Danish), with
  troubleshooting. The app also serves it at `/docs/setup-microsoft-teams.md`.
- [`DEPLOY.md`](DEPLOY.md#microsoft-login-and-teams-referater): the server side,
  including every Teams env var and what changes when you upgrade.
- [`docs/outlook-addin.md`](docs/outlook-addin.md): the optional Outlook button
  that switches transcription on from the meeting form.

## Scripts

- `npm run dev` — start the Next.js dev server
- `npm run build` / `npm start` — production build and serve
- `npm test` — run the Vitest suite
- `npm run db:generate` / `db:migrate` / `db:studio` — Drizzle migrations
