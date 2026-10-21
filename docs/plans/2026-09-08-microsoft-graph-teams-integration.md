# Plan: Replace the Playwright Teams bot with Microsoft Graph

Date: 2026-09-08. Deadline: 2026-09-22 (two weeks).

## 0. The one decision that shapes everything

Microsoft offers two fundamentally different ways to get meeting content:

| | A. Real-time media bot | B. Meeting artifacts (transcript + recording) |
|---|---|---|
| What you get | Live audio, **unmixed per participant** (up to 4 dominant speakers), participant ids | Teams' own transcript (VTT with **speaker display names** and timestamps) and the recording (mp4), available minutes after the meeting ends |
| How | Graph Cloud Communications `calls` API + `Microsoft.Graph.Communications.Calls.Media` SDK | Plain REST: `/users/{id}/onlineMeetings/{id}/transcripts` and `/recordings`, optional change notifications |
| Runtime | **C#/.NET on Windows Server in Azure only**, public TLS cert, dedicated media ports, min 2 vCPU | Anything with `fetch` |
| Client setup | Azure Bot registration, app permissions `Calls.JoinGroupMeeting.All` + `Calls.AccessMedia.All`, admin consent, bot must be admitted from lobby every meeting | App registration (we already have one for login), delegated Graph scopes, one admin consent |
| Live pause/resume/timer | Yes | No. Teams controls recording; we consume afterwards |
| Speaker attribution | Exact, from audio channel | Exact names from the Teams transcript; our hviske text is aligned to it by time overlap |
| Fits in 2 weeks with this team and stack | No. New language, new OS, new hosting, and the media SDK is the part Microsoft documents least | Yes |

**Recommendation: B.** Per-person audio streams exist but are locked behind a Windows/C# media platform that cannot run in this repo's Node + Alpine Docker stack. Approach B still delivers the thing you actually want from per-person audio, which is names on speakers in Gennemgang, because Teams' transcript already carries `<v Display Name>` per utterance. We keep hviske for Danish text quality and borrow only the speaker timeline from Microsoft.

What we give up: the live "optager 12:34, 4 deltagere" screen, and pause/resume. In exchange the product becomes "schedule a meeting with Memoctopus enabled": the user arms a meeting ahead of time, Graph flips the meeting's own auto-record and transcription options, and Teams does the recording. Nobody has to invite or admit a bot, and nobody has to remember to press anything during the meeting. Section 3 describes it.

Sources: [application-hosted media requirements](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/requirements-considerations-application-hosted-media-bots), [media hosting options](https://learn.microsoft.com/en-us/graph/cloud-communications-media), [transcript change notifications](https://learn.microsoft.com/en-us/graph/teams-changenotifications-callrecording-and-calltranscript), [List transcripts](https://learn.microsoft.com/en-us/graph/api/onlinemeeting-list-transcripts?view=graph-rest-1.0), [Teams transcription languages incl. Danish](https://learn.microsoft.com/en-us/microsoftteams/meeting-transcription-captions).

## 1. Auth model: delegated, through the login we already have

Two ways to call Graph:

- **Application permissions** (`OnlineMeetingTranscript.Read.All` app role). Works for any organizer, but the tenant admin must also run PowerShell (`New-CsApplicationAccessPolicy` + `Grant-CsApplicationAccessPolicy`) for every user or group whose meetings we may read. Extra client friction, and it is the step customers get wrong.
- **Delegated permissions** on the signed-in user's Entra ID token. No application access policy. Requires only that the admin consents once to the scopes. Works for meetings on the user's own calendar, as organizer **or invited attendee**.

**Recommendation: delegated.** The app already has Entra ID login via better-auth, and better-auth stores `access_token`, `refresh_token` and `scope` in the `account` table. We add scopes to the existing provider, request `offline_access` so we get a refresh token, and read Graph as the user. Client setup collapses to "add these permissions to the app registration you already created and click Grant admin consent".

Scopes to request on the `microsoft` social provider:

```
openid profile email offline_access
OnlineMeetings.ReadWrite
OnlineMeetingTranscript.Read.All
OnlineMeetingRecording.Read.All
Calendars.Read
```

`OnlineMeetings.ReadWrite` (not just `.Read`) is what lets us arm a meeting by PATCHing its options (section 3). `Calendars.Read` is for the upcoming-meetings picker. If the customer objects to calendar access, the paste-a-link flow works without it.

Constraints this implies, to be written into the admin guide:

- Users must sign in with Microsoft to use Teams features. Email/password or generic OIDC users see the Teams entry point disabled with an explanation.
- `MICROSOFT_TENANT_ID` should be the customer's tenant id, not `common`, so consent is tenant-wide.
- Existing Microsoft users need to sign in again once to grant the new scopes. Detect missing scopes from the stored `scope` column and prompt re-consent.

## 2. Target architecture

```
Dashboard ──(pick meeting / paste link)──► POST /api/teams/meetings
                                             │ resolve join URL → onlineMeeting id, organizer, start/end
                                             │ arm: PATCH /me/onlineMeetings/{id}
                                             │      {recordAutomatically, allowTranscription, meetingSpokenLanguageTag}
                                             ▼
                                   teams_meetings row: graph_meeting_id, armed=true|false,
                                                       state='awaiting_teams'
                                             │
   (meeting happens in Teams; it records and transcribes itself because it was armed)
                                             │
      Poller (server) ── every N min after scheduled end, or on page open ──► Graph:
        GET /me/onlineMeetings/{id}/transcripts        GET /me/onlineMeetings/{id}/recordings
        GET .../transcripts/{tid}/content?$format=text/vtt   GET .../recordings/{rid}/content
                                             │
                                             ▼
        src/lib/teams/artifacts.ts  →  VTT → SpeakerTurn[] with real names
                                    →  mp4 → ffmpeg → wav → existing hviske pipeline (bot-transcribe.ts)
                                    →  assignSpeakers(segments, turnsFromVtt)   (merge-speakers.ts, unchanged)
                                             │
                                             ▼
                        pending-audio stash (bot-pending-audio.ts, unchanged) → existing
                        /api/bot/audio + /api/bot/transcript hand-off → ProcessingTranscription → Gennemgang
```

### Arming a meeting ("Memoctopus enabled")

When the user enables Memoctopus on a meeting, `meeting-arm.ts` runs one PATCH against `/me/onlineMeetings/{id}` as the organizer:

```json
{
  "allowRecording": true,
  "allowTranscription": true,
  "recordAutomatically": true,
  "meetingSpokenLanguageTag": "da-DK"
}
```

That is the same thing as the organizer ticking "Record and transcribe automatically" and choosing Danish in the Teams meeting options, so the meeting records and transcribes itself from the moment the first person joins, and the transcript arrives in Danish without anyone picking a language. All four properties are documented on the v1.0 `onlineMeeting` resource and writable via Update. Only the organizer can update meeting options, so:

- Organizer: arm succeeds, the meeting is registered for polling, screen says "Memoctopus er slået til. Mødet optages og transskriberes automatisk."
- Invitee: we cannot PATCH. Register for polling anyway (transcripts are readable by invitees) and tell the user to ask the organizer to enable "Optag og transskriber automatisk", with a copy-paste sentence. This is the only path where a human still has to act.

Recurring series: one `onlineMeeting` covers the whole series, so arming it arms every occurrence. Store which occurrence the user asked for and pick artifacts by `createdDateTime` inside that window. Arming a series once is a feature: "alle vores ugentlige møder får referat".

`meetingSpokenLanguageTag` is fixed to `da-DK` for now, exposed later as a setting if a customer needs another language.

### New modules (all in `src/lib/teams/`)

| Module | Responsibility | Depends on |
|---|---|---|
| `graph-client.ts` | `graphFetch(userId, path, init)`. Gets a fresh token via better-auth (`auth.api.getAccessToken({ providerId: 'microsoft', userId })`, which refreshes when expired), adds bearer header, maps 401/403 to typed errors (`GraphAccessToTranscriptsDisabled`, `ConsentRequired`, `NotFound`). | better-auth, `account` table |
| `meeting-arm.ts` | `armMeeting(userId, graphMeetingId)` → PATCH options above; returns `armed` or `notOrganizer`. Idempotent. | graph-client |
| `meeting-resolver.ts` | `resolveJoinUrl(userId, url)` → `GET /me/onlineMeetings?$filter=JoinWebUrl eq '<url>'`. Also `listUpcomingMeetings(userId)` via `GET /me/calendarView?startDateTime&endDateTime&$filter=isOnlineMeeting eq true`. Pure URL validation (`teams.microsoft.com`, `teams.live.com`) ported from `bot-service/src/lib/url-validator.ts`. | graph-client |
| `vtt.ts` | Pure parser: WebVTT with `<v Name>` cues → `{ speaker: string, start: number, end: number, text: string }[]`. Also `turnsFromVtt()` → `SpeakerTurn[]` in the shape `merge-speakers.ts` expects, and `segmentsFromVtt()` for the transcript-only fallback. | nothing |
| `artifacts.ts` | `fetchArtifacts(userId, meetingId)` → lists transcripts + recordings, downloads newest of each, returns `{ vtt?: string, recording?: ReadableStream, duration?: number }`. | graph-client |
| `pipeline.ts` | Orchestrates one meeting: fetch artifacts → decide mode (see below) → run hviske via existing `processBotRecording()` with `turns` injected → stash result. Idempotent per meeting. | artifacts, vtt, bot-transcribe, bot-pending-audio, ffmpeg |
| `poller.ts` | `pollDueMeetings()` runs on a timer inside the Next.js server (instrumentation hook or a `setInterval` guarded by a DB advisory lock) and also on demand when the user opens a meeting in `awaiting_teams`. Backoff: every 2 min for the first 30 min after scheduled end, then every 15 min, give up after 24 h → status `failed` with reason. | pipeline |

Processing modes, chosen per meeting from what Graph returns:

1. **Recording + transcript** (target): hviske text, speaker names from VTT. Best quality.
2. **Transcript only**: use VTT text directly, skip hviske and diarization. Lower Danish quality but zero audio handling. Also the privacy-friendly mode, since no recording is ever stored in the customer's OneDrive.
3. **Recording only**: current behaviour, hviske + pyannote `Taler N` labels.
4. **Nothing after 24 h**: `failed`, with a Danish message saying transcription was never started in Teams.

Make mode 2 selectable per deployment via `TEAMS_ARTIFACT_MODE=transcript-only|prefer-recording` so a municipality that forbids recordings can still use the product.

### Speaker names in Gennemgang

`assignSpeakers()` today remaps pyannote labels to `Taler N`. Add a flag so that when turns already carry human names (from VTT), they are kept verbatim. `TranscriptReview.tsx` then sees segments whose `speaker` is already "Mette Hansen", and the participants list comes from the distinct VTT speakers, so the assignment step is pre-filled and the user only corrects, not maps. `isDefaultSpeakerLabel()` already distinguishes `Taler N` from real names, so the existing UI logic for "unassigned voices" works unchanged.

### Reused unchanged

`bot-pending-audio.ts`, `bot-transcribe.ts` (add an optional `turns` parameter), `merge-speakers.ts`, `/api/bot/audio/[meetingId]`, `/api/bot/transcript/[meetingId]`, `ProcessingTranscription.tsx`, everything downstream of `review`. Rename the `bot-*` files to `teams-*` in the cleanup phase, not before.

### Data model

Meetings live in IndexedDB on the client, with only `source`, `meeting_url`, `bot_session` mirrored server-side and a server-side owner stash. The poller needs a server-side record to know what to poll. Add to `ensureUserSchema()` (idempotent ALTERs, same idiom as today):

```
teams_meetings (
  id TEXT PRIMARY KEY,            -- our meeting id
  graph_meeting_id TEXT NOT NULL,
  join_url TEXT NOT NULL,
  subject TEXT,
  scheduled_start TIMESTAMPTZ,
  scheduled_end TIMESTAMPTZ,
  state TEXT NOT NULL,            -- awaiting_teams | fetching | ready | failed
  last_polled_at TIMESTAMPTZ,
  attempts INT NOT NULL DEFAULT 0,
  failure_reason TEXT
)
```

Drop `bot_session` from the client `Meeting` type and IndexedDB schema. Client status `joining` is replaced by `awaiting_teams`.

## 3. User experience

The mental model for the user is one switch per meeting: "Memoctopus slået til". Two ways to flip it, plus one hidden way for later.

**Dashboard: "Kommende Teams-møder"** (needs `Calendars.Read`). Lists the next 7 days of the user's online meetings from `/me/calendarView`, each with a toggle "Tag referat". Turning it on calls `POST /api/teams/meetings`, which resolves the Graph meeting, arms it, and registers it for polling. Meetings already armed show a green badge and appear in the meeting list in state `awaiting_teams`. This is the flow the customer should be taught: schedule in Outlook as usual, open Memoctopus, flip the switch. Zero change to how they invite people.

**Dashboard: paste a link.** Keeps today's input box for meetings not on the calendar view (someone forwarded a link, or the meeting is more than 7 days out). Same endpoint, same result.

**Optional: create the meeting from Memoctopus.** A small "Nyt Teams-møde" form (subject, time, attendees) that does `POST /me/events` with `isOnlineMeeting: true` and then arms it. Cheap once the two flows above exist, but it competes with Outlook, so build only if the customer asks. Not in the two-week scope.

**Meeting screen in `awaiting_teams`** (replaces `MeetingBotScreen.tsx`):

- Subject, time, "Åbn i Teams" button, and the armed badge.
- If armed: "Mødet optages og transskriberes automatisk. Referatet er klar automatisk et par minutter efter mødet." No instructions needed.
- If not armed (user is invitee): the copy-paste sentence for the organizer, and a note that the transcript will still be picked up if anyone starts transcription manually.
- State line from polling `GET /api/teams/meetings/[id]`: "Venter på mødet" → "Mødet er slut, henter transskription fra Teams" → auto-route to `/meeting/<id>/review` when `ready`.
- "Tjek nu" (forces a poll), "Slå Memoctopus fra" (un-arm: PATCH `recordAutomatically: false` only if we set it, and stop polling).

**Why not "invite referat@kommune.dk to the meeting"?** It is the most natural gesture, and it is worth a spike after the two weeks, but it is not the v1 mechanism for two reasons. First, it requires application permissions plus an application access policy for the mailbox, which is the PowerShell setup step we are trying to spare the customer. Second, the transcript and recording APIs are documented for the organizer and for calendar invitees using their own delegated token; whether an app-only token scoped to an attendee mailbox can read another organizer's transcripts is not documented and needs testing on a real tenant. The toggle above gives the same outcome with verified APIs. If the spike succeeds, the invite flow becomes an additional entry point feeding the same `teams_meetings` table, not a different architecture.

## 4. Client (tenant admin) setup, as short as it gets

Ship as `docs/setup-microsoft-teams.md` in Danish, with screenshots, and link it from the Teams screen when Graph returns a consent or 403 error.

1. Entra admin center → App registrations → the existing Referat app → API permissions → Add → Microsoft Graph → Delegated → tick the five scopes → **Grant admin consent**.
2. Teams admin center → Meetings → Meeting policies → Recording & transcription → Transcription: On, Meeting recording: On. Both must be allowed by policy or the per-meeting `recordAutomatically` option is ignored.
3. Optional: Teams admin center → Meeting settings → ensure Graph API access to transcripts is not disabled (this is the toggle behind the `GraphAccessToTranscriptsDisabled` 403).
4. Tell users to sign in to Referat with Microsoft and flip "Tag referat" on the meetings they want minutes for.

No PowerShell, no Azure Bot resource, no new app registration, no public webhook endpoint.

## 5. Cleanup of the current bot

Do this in the second week, after the Graph path works end to end on a real tenant, so a rollback stays possible.

Delete:

- `bot-service/` entirely, including its Dockerfile, compose file, tests. Tag the last commit that contains it (`git tag bot-service-final`) so it can be resurrected.
- `docker-compose.yml`: the `bot-service` service, `shm_size`, `mem_limit`, `oom_score_adj`, `stop_grace_period`, the `depends_on` from `app`, `BOT_SERVICE_URL`, `BOT_INTERNAL_SECRET`, `NEXT_APP_URL`, `BOT_MAX_SESSIONS`, `HEADLESS`, `DISPLAY`, `BOT_DEBUG_SNAPSHOTS`.
- `package.json`: the bot part of `dev`, `predev` port kill for 3001.
- `src/app/api/bot/sessions`, `/status`, `/control`, `/audio-upload` and their tests.
- `src/lib/bot-service.ts` and test.
- `src/components/recording/MeetingBotScreen.tsx` and test.
- `src/lib/data/meeting-page.ts` (already dead code, imports nowhere).

Rename (keep behaviour):

- `src/lib/bot-pending-audio.ts` → `src/lib/teams/pending-artifacts.ts`
- `src/lib/bot-transcribe.ts` → `src/lib/teams/transcribe.ts`
- `src/app/api/bot/audio/[meetingId]` and `/transcript/[meetingId]` → `src/app/api/teams/meetings/[id]/audio` and `/transcript`; update `ProcessingTranscription.tsx` and `MeetingPageClient.tsx`.

Update: `CLAUDE.md` (sections "Bot API routes", "Bot service", Docker, env table; also fix the stale `'creating'` sentinel and port 3002 claims), `.env.example`, `DEPLOY.md`, `readme.md`.

Keep the `audio-storage` volume; it is where pending artifacts land.

## 6. Two-week schedule

Assumes one developer, and that a test tenant where you are admin exists on day 1. If it does not, creating a Microsoft 365 Developer tenant is the first task, because every later step blocks on it.

| Day | Deliverable | Done when |
|---|---|---|
| 1 | Scopes added to the Microsoft provider; `graph-client.ts` with token refresh; scope-gap detection. Verify `auth.api.getAccessToken` refresh behaviour on the installed better-auth version. | `GET /me` and `GET /me/onlineMeetings?$filter=...` succeed in a test route with a real token. |
| 2 | `meeting-resolver.ts`, `vtt.ts` (pure, TDD), `teams_meetings` table in `ensureUserSchema`. | Unit tests green; a pasted link resolves to a Graph meeting id. |
| 3 | `meeting-arm.ts` (PATCH options), `POST /api/teams/meetings`, `GET /api/teams/meetings/[id]`, new awaiting screen replacing `MeetingBotScreen`. | Arming a meeting from the dashboard makes Teams show "Optag og transskriber automatisk" as on in the meeting options page, and the waiting screen shows the armed badge. |
| 4 | `artifacts.ts` + `pipeline.ts`: download VTT + mp4, ffmpeg to wav, hviske via existing `processBotRecording` with VTT turns. | One real armed meeting, nobody pressing anything in Teams, goes from `awaiting_teams` to Gennemgang with real names. |
| 5 | `poller.ts` with backoff and on-demand trigger; modes 2, 3 and 4; failure messages in Danish. | Meeting without transcription fails cleanly after timeout; transcript-only mode works. |
| 6 | `assignSpeakers` name-preserving flag; Gennemgang pre-filled participants; "Kommende Teams-møder" picker with the toggle on the dashboard; invitee (not organizer) path. | Review step shows names, not `Taler N`; a meeting can be armed from the calendar list with one click. |
| 7 | End-to-end run on the customer-like tenant with a non-admin user. Fix what breaks (lobby, expired tokens, channel meetings, recurring series). | Second real meeting passes without developer intervention. |
| 8 | Cleanup: remove bot-service and routes, renames, compose, package.json, tag. | `npm test`, `npm run build`, `docker compose up` all pass without the bot. |
| 9 | Docs: `docs/setup-microsoft-teams.md` (Danish, screenshots), CLAUDE.md, .env.example, DEPLOY.md. Error screens link to the guide. | A colleague follows the guide on a fresh tenant and gets a referat. |
| 10 | Buffer. If unused: spike the "invite a Memoctopus mailbox" entry point on the test tenant, or change-notification webhooks instead of polling. | |

## 7. Risks and how they are handled

- **Nobody starts transcription.** Only possible when the user is an invitee, since armed meetings transcribe themselves. Meeting ends in `failed` with a clear message naming the organizer.
- **Tenant policy blocks recording or transcription.** The PATCH succeeds but Teams ignores it. Detect by reading the meeting back after arming and comparing; if the policy blocks it, say so on the screen and point to admin guide step 2.
- **`recordAutomatically` records to the organizer's OneDrive for every occurrence of an armed series.** Say so in the UI when arming a recurring meeting, and make un-arming a first-class action.
- **Tenant has disabled Graph transcript access.** Detect `GraphAccessToTranscriptsDisabled` and show the admin guide step 3. No workaround exists.
- **Meeting not on the user's calendar** (ad hoc "Mød nu", or someone pasted a link they were not invited to). The transcripts API only covers calendar meetings the user is party to. Show "Du skal være inviteret til mødet" at resolve time, so the failure is immediate, not after the meeting.
- **Recording lands in the organizer's OneDrive/SharePoint** under the customer's retention rules. This is Microsoft's behaviour, not ours. Transcript-only mode exists for customers who object.
- **Artifact latency.** Typically a few minutes after the meeting ends, occasionally longer. The waiting screen says so.
- **Token refresh.** If the refresh token is revoked (password change, conditional access), the poller marks the meeting `needs_reauth` and the UI asks the user to sign in with Microsoft again, then retries.
- **Scope of a "meeting" differs.** Recurring series produce one `onlineMeeting` id with many transcripts. Pick artifacts whose `createdDateTime` falls inside the occurrence the user chose.
- **Better-auth version.** `getAccessToken` with automatic refresh exists in current 1.x releases. Day 1 verifies it on the installed version; fallback is a 40-line manual refresh against `login.microsoftonline.com/{tenant}/oauth2/v2.0/token`.

## 8. Explicitly out of scope

- Real-time media bot (approach A). Revisit only if a customer demands live in-meeting features and will fund a Windows/C# service.
- Azure Communication Services. Its JS Calling SDK cannot deliver unmixed audio and Call Automation cannot join Teams meetings, so it does not improve on either approach.
- Change-notification webhooks. Polling is enough for the meeting volumes here and avoids a public endpoint, certificate-encrypted payloads and subscription renewal. Listed as phase 2.
- Channel meetings and live events. Graph excludes private channel meetings from transcript subscriptions and live events from the transcripts API.
