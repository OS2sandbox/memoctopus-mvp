# Testing the Teams (Microsoft Graph) integration locally

Two ways: **offline against a mock Graph server** (no tenant, minutes to set up,
proves the app side), and **against a real tenant** (proves consent, policy and
Microsoft's behaviour). Do the mock first; it catches app bugs without waiting for
a real meeting to end.

## A. Offline with the mock Graph server

The mock (`scripts/mock-graph/server.mjs`, no dependencies) serves the slice of
`graph.microsoft.com/v1.0` that `src/lib/teams/*` uses: `/me`, `/me/calendarView`,
`/me/onlineMeetings` lookup by join URL, meeting option PATCH, transcripts (VTT)
and recordings (302 to an off-origin blob, like real Graph). On macOS it
synthesises a 30 s Danish two-speaker recording with `say` + ffmpeg and derives the
VTT timings from it, so hviske gets real speech and speaker names line up.

### 1. Database

Use a scratch database so the mock account link never touches real data:

```bash
createdb -h localhost -U postgres referat_mock   # or psql -c "create database referat_mock"
DATABASE_URL=postgres://postgres:postgres@localhost:5432/referat_mock npm run db:migrate
```

### 2. Start the mock

```bash
MOCK_ARTIFACT_DELAY_MS=5000 npm run mock:graph
```

It prints the meetings it knows and their join links:

| id | you are | scheduled | use it for |
|---|---|---|---|
| `mtgpast` | organizer | ended 10 min ago, artifacts ready | the happy path, instantly |
| `mtgsoon` | organizer | starts in 5 min | arming; end it by hand to test pickup |
| `mtginvitee` | invitee | in 1 h | the "ask the organizer" path |
| `mtgweekly` | organizer | tomorrow, recurring | series handling in the calendar list |

Control endpoints (no auth):

```bash
curl localhost:4010/__mock/state                                  # everything, incl. request log
curl -X POST localhost:4010/__mock/meetings/mtgsoon/end -H 'content-type: application/json' -d '{}'
curl -X POST localhost:4010/__mock/settings -H 'content-type: application/json' -d '{"transcriptsDisabled":true}'
curl -X POST localhost:4010/__mock/settings -H 'content-type: application/json' -d '{"policyBlocked":true}'
curl -X POST localhost:4010/__mock/reset
```

`transcriptsDisabled` makes transcript calls answer the tenant-level 403
(`GraphAccessToTranscriptsDisabled`); `policyBlocked` makes the PATCH succeed but
keep `recordAutomatically` false, which the app must detect as `policy_blocked`.
A meeting that nobody ends by hand "ends" `MOCK_ARTIFACT_DELAY_MS` after its
scheduled end, with artifacts only if it was armed.

The blob host the recording redirects to rejects any request carrying an
`Authorization` header, so a leaked Graph token shows up as a 400 in the log.

### 3. Start the app against the mock

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/referat_mock \
MICROSOFT_CLIENT_ID=mock MICROSOFT_CLIENT_SECRET=mock MICROSOFT_TENANT_ID=mock \
GRAPH_BASE_URL=http://localhost:4010/v1.0 \
TEAMS_POLL_INTERVAL_MS=10000 \
TEAMS_ARTIFACT_MODE=transcript-only \
npx next dev -p 3004
```

`MICROSOFT_*` only need to exist: better-auth refuses to hand out a token for a
provider that is not registered, even when the account row is there. Everything
else (hviske, OpenAI, storage) comes from `.env` as usual. Start with
`transcript-only`; switch to `prefer-recording` once hviske is reachable to see
hviske text with Teams names.

### 4. Create a user and link it to the fake Microsoft account

Sign up with email/password in the browser (or via the API), then:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/referat_mock \
  npm run mock:graph:seed -- you@example.com
```

This inserts an `accounts` row for provider `microsoft` with a token the mock
accepts, an expiry in 2099 (so better-auth never tries to refresh) and the full
Graph scope list. `--remove` takes it away again. Reload the dashboard: the
"Kommende Teams-møder" section appears.

### 5. Walk the flow

1. Dashboard → "Kommende Teams-møder" → **Tag referat** on *Budgetmøde Q4*. Check
   `/__mock/state`: `recordAutomatically`, `allowTranscription` and
   `meetingSpokenLanguageTag=da-DK` are now set on `mtgsoon`.
2. Same on *Møde hvor du kun er inviteret*: you get the organizer instructions.
3. Paste the `mtgpast` join link into the "deltag i et møde" box. Its artifacts are
   ready, so within one poll interval (or on **Tjek nu**) the meeting goes to
   Gennemgang with *Mette Hansen* and *Jens Nielsen* on the segments.
4. End `mtgsoon` by hand with the control endpoint. Note: the poller only starts
   asking Graph after the meeting's **scheduled** end, so a meeting ended early
   waits until then. Use `mtgpast` for instant results.
5. Flip `transcriptsDisabled` / `policyBlocked` and repeat steps 1 and 3 to see the
   admin-guide error paths.

The same flow through curl, which is how the smoke test in the PR was run:

```bash
B=http://localhost:3004
curl -c cj -H 'content-type: application/json' -H "origin: $B" -X POST $B/api/auth/sign-up/email \
  -d '{"email":"you@example.com","password":"Passw0rd!xyz","name":"Test"}'
curl -b cj $B/api/teams/status
curl -b cj "$B/api/teams/calendar?days=7"
curl -b cj -H 'content-type: application/json' -H "origin: $B" -X POST $B/api/teams/meetings \
  -d '{"meetingId":"m1","joinUrl":"<mtgpast join url from the mock banner>"}'
curl -b cj "$B/api/teams/meetings/m1?poll=1"
curl -b cj $B/api/meetings/m1/pending-transcript
```

## B. Against a real tenant

You need a Microsoft 365 tenant where you are Global Admin, with two users licensed
for Teams (Business Basic or higher, or E3/E5).

1. **App registration** (Entra admin center → App registrations → the app you use
   for login, or a new one):
   - Redirect URI (Web): `http://localhost:3004/api/auth/callback/microsoft`
   - A client secret.
   - API permissions → Microsoft Graph → *Delegated*: `OnlineMeetings.ReadWrite`,
     `OnlineMeetingTranscript.Read.All`, `OnlineMeetingRecording.Read.All`,
     `User.Read`, `offline_access` → **Grant admin consent**.
2. **Teams admin center** → Meetings → Meeting policies → Global → Recording &
   transcription: *Transcription* **On**, *Meeting recording* **On**. Takes up to
   an hour to propagate. Without both, arming reports `policy_blocked`.
3. `.env`: `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID`
   (the tenant id, not `common`), `TEAMS_POLL_INTERVAL_MS=30000`, and **no**
   `GRAPH_BASE_URL`. Remove any mock account row first
   (`npm run mock:graph:seed -- you@example.com --remove`) or use a different database.
4. Sign in with Microsoft. The consent screen must list the meeting and calendar
   scopes. If you had signed in with Microsoft before, sign out and in again so the
   stored scopes are refreshed; `/api/teams/status` should report `scopesOk: true`.
5. In Outlook or Teams, schedule a meeting starting in a few minutes, invite the
   second user. On the dashboard, **Tag referat**. Open the meeting's *Meeting
   options* in Teams: "Record and transcribe automatically" is now on and the
   spoken language is Danish.
6. Join as both users, talk Danish for two or three minutes, then **End meeting
   for all**. Transcripts usually appear within a few minutes, recordings a bit
   later. The waiting screen polls every 15 s; **Tjek nu** forces it.
7. Cross-check in Graph Explorer as the same user when nothing shows up:
   `GET /me/onlineMeetings?$filter=JoinWebUrl eq '<join url>'`, then
   `GET /me/onlineMeetings/{id}/transcripts`. Transcript there but not in the app
   → our bug. Not there → transcription never started in Teams.
8. Try once each: a meeting where the other user is organizer, and
   `TEAMS_ARTIFACT_MODE=transcript-only`.
