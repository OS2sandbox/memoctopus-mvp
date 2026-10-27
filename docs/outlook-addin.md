# The Outlook add-in

A button on Outlook's meeting form, **OS2taletiltekst**, that switches the Teams
integration on for a meeting, so nobody has to paste the join link into the
dashboard. Everything after the button is the existing Graph pipeline
(`src/lib/teams/`).

## How it works

1. The organizer opens a Teams meeting in Outlook and presses the button. The task
   pane (`outlook-addin/src/`, served from `/outlook-addin/taskpane.html` on this
   host) reads the meeting text and finds the Teams link with
   `src/lib/outlook/join-link-from-body.ts`. In new Outlook and Outlook on the web
   the link is only in the text once the invitation has been sent.
2. The pane signs in with **nested app authentication (NAA)**: Outlook brokers an
   Entra access token for this app's own API (`api://<client-id>/access_as_user`),
   silently, or with a Microsoft pop-up the first time.
3. It calls `POST /api/outlook/meetings` with that token. The server verifies it
   (`src/lib/outlook/addin-auth.ts`: signature from the tenant's keys, issuer and
   `tid` = our tenant, audience = our API, issued to our client, scope
   `access_as_user`), finds the user by the token's `sub` (the Microsoft account id
   better-auth stored at dashboard sign-in), and registers and arms the meeting
   exactly as the dashboard's Mødelink box does (`src/lib/teams/register.ts`).
   The row is marked `origin = 'outlook'`.
4. The dashboard and the Arkiv import Outlook meetings they have not seen from
   `GET /api/teams/meetings` (`src/lib/outlook/import-meetings.ts`), under the
   server's id, as ordinary Graph-managed Teams meetings.

A user must have signed in to OS2taletiltekst with Microsoft once: that is where the
delegated Graph token the server arms with comes from.

### The storage rule

Someone who arms a meeting from Outlook comes back later, maybe days later. So for
`origin = 'outlook'` rows the background poller does nothing until the user **opens
the meeting** in OS2taletiltekst (the screen's forced poll sets `opened_at`). Until
then the recording stays where Teams put it, in the organizer's OneDrive. Opening it
starts the fetch with the user there to collect the transcript, and the recording is
deleted from OneDrive once transcribed, as for any Teams meeting. A meeting nobody
opens within 30 days (`OUTLOOK_UNOPENED_GIVE_UP_MS`) is marked failed and is never
fetched, even if it is opened later. Its recording is not deleted by us (nothing was
downloaded to identify it by); it stays under the tenant's own Teams retention.
See `isDeferred()` in `src/lib/teams/store.ts` and the top of `pollMeeting()`.

## Turning it on

### 1. The app registration (Entra admin, once)

On the **existing** app registration the dashboard signs in with (the one in
`MICROSOFT_CLIENT_ID`). All three are additive; the dashboard's sign-in is unaffected.

| Where | What |
|---|---|
| Authentication → Add a platform → Single-page application | Two redirect URIs, both under *Single-page application* (not *Web*): `brk-multihub://<this host>` and `brk-9199bf20-a13f-4107-85dc-02114787ef48://<this host>`, e.g. `brk-multihub://taletiltekst.example.dk`. The host only: no `https://`, no path. The second is Outlook on the web's own broker; without it sign-in there fails with AADSTS700046 |
| Expose an API | Application ID URI `api://<client-id>`; add scope `access_as_user` (who can consent: admins and users; enabled) |
| API permissions → Add → My APIs → this app | Delegated `access_as_user`, then **Grant admin consent** |
| Manifest | `"requestedAccessTokenVersion": 2` (v2 tokens; v1 is accepted too) |

### 2. The server

```bash
OUTLOOK_ADDIN_ENABLED=true   # needs TEAMS_GRAPH_ENABLED=true and a tenant-id MICROSOFT_TENANT_ID
docker compose … up -d app   # a restart is enough; the add-in is built into the image
```

The manifest is then served at `https://<this host>/outlook-addin/manifest.xml`.

### 3. Deploying the add-in (Exchange or Global admin)

Microsoft 365 admin center → **Settings → Integrated apps → Upload custom apps** →
app type *Office Add-in* → upload the manifest **file** (the URL option needs the
server to be reachable from Microsoft's cloud). Assign it to specific users or a
group. It can take up to 24 hours before the button appears in Outlook.

When `src/lib/outlook/manifest.ts` changes, bump `ADDIN_VERSION` and upload the new
file: the admin center keeps the file it was given. Changes to the pane itself
(`outlook-addin/src/`) need only a deploy.

## When it does not work

**"Mødet har endnu intet Teams-link."** In new Outlook and Outlook on the web the
Teams link only lands in the meeting text once the meeting is saved or sent, and the
pane reads the text when it opens. Save the meeting, open it again from the
calendar, and press the button.

**"Microsoft-login mislykkedes … Fejlkode: …"** The pane shows the code Entra or
MSAL gave. The full error is in the browser console (F12), on the line starting
`[os2taletiltekst]`; its Correlation ID finds the attempt in Entra's sign-in logs.

| Code | Cause | Fix (app registration) |
|---|---|---|
| `AADSTS700046` "Reply Address must have scheme brk-…://" | The redirect URI for that Outlook's broker is missing, or registered as *Web* | Add the URI the message names, `brk-<id>://<this host>`, under *Single-page application* |
| `AADSTS50011` | Redirect URI does not match the host | Check the host in both `brk-…://` URIs is exactly the one the add-in loads from |
| `AADSTS500011` "resource principal … not found" | Application ID URI is not `api://<client-id>` | Expose an API → set it to `api://<client-id>` |
| `AADSTS65001` | No consent for `access_as_user` | API permissions → Grant admin consent |
| `AADSTS53003` | Conditional Access blocks the sign-in | An exception for the app, or for NAA |

Lines in the console from Outlook itself (`owa.*.js`, `[Violation] … unload is not
allowed`) are Outlook's own and unrelated.

## Limits

- Outlook must reach this host: on the municipality's network or VPN.
- Only the organizer can switch recording on; an invitee gets the meeting registered
  and is told the organizer must start transcription.
- Classic Outlook older than build 2409 and Office LTSC have no NAA; the pane says
  so, and the Mødelink box still works.
- A Conditional Access rule "Require approved client app" blocks NAA for its users.
