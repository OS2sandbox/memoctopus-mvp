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
starts the fetch with the user there to collect the transcript. As for any Teams
meeting, the recording is then deleted from OneDrive once the user's browser has
saved the transcript, unless `TEAMS_DELETE_RECORDING=false` or
`TEAMS_ARTIFACT_MODE=transcript-only`, where it is never deleted. The pane's note
says which applies (`deletesRecording` from `GET /api/outlook/config`). A meeting
nobody opens within 30 days (`OUTLOOK_UNOPENED_GIVE_UP_MS`) is marked failed and is
never fetched, even if it is opened later. Its recording is not deleted by us
(nothing was downloaded to identify it by); it stays under the tenant's own Teams
retention. See `isDeferred()` in `src/lib/teams/store.ts` and the top of
`pollMeeting()`.

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

#### Alternative: the add-in's own app registration (`OUTLOOK_ADDIN_CLIENT_ID`)

When the Microsoft 365 admin center deploys the add-in, it creates a second app
registration of its own, usually with the add-in's name (created by "Office 365
Portal", with the add-in listed under `addIns` in its manifest). If the dashboard's
registration cannot be changed, the add-in can sign in with that one instead:

| Where (on the add-in's registration) | What |
|---|---|
| Authentication → Single-page application | The same two `brk-…://<this host>` redirect URIs as above. If the page refuses them, the *Microsoft Graph App Manifest* tab takes them under `"spa"` → `"redirectUris"` |
| API permissions | Nothing to add. If the tenant does not let users consent, **Grant admin consent** for sign-in (`openid`, `profile`) when the pop-up asks for approval |

Then set `OUTLOOK_ADDIN_CLIENT_ID=<that app's client id>` on the server. The add-in
asks for that app's **ID token** instead of an access token, and the server
(`verifyAddinIdToken()`) checks its signature, issuer and `tid` (our tenant), audience
(that app), that it is an ID token, and that it carries an `oid`. `sub` differs per
app registration, so the user is found by **object id** instead: the `oid` in the ID
token better-auth stored at their dashboard sign-in. Nothing about Graph changes;
every Graph call still uses the user's dashboard grant. Leave the variable empty to go
back to the dashboard's registration.

### 2. The server

```bash
OUTLOOK_ADDIN_ENABLED=true   # needs TEAMS_GRAPH_ENABLED=true and a tenant-id MICROSOFT_TENANT_ID
OUTLOOK_ADDIN_ALLOWED_USERS=someone@example.dk   # optional: only these users; empty = everyone
OUTLOOK_ADDIN_CLIENT_ID=     # optional: the add-in's own app registration (see above)
docker compose … up -d app   # a restart is enough; the add-in is built into the image
```

The manifest is then served at `https://<this host>/outlook-addin/manifest.xml`.
If it answers 404 although the flag is set, the server log says why, once per
start (`[outlook] OUTLOOK_ADDIN_ENABLED=true, but the add-in stays off: …`).

Outlook and the admin center tell add-ins apart by the manifest's id. Every
deployment uses the same one unless told otherwise, so when two deployments share
a tenant (staging and production), give all but one its own:

```bash
OUTLOOK_ADDIN_ID=<a new GUID>   # e.g. from `uuidgen`; must be a GUID, or the manifest is refused
```

Leave it unset on the deployment users already have: changing the id makes a new
add-in, which the admin uploads and assigns again (and removes the old one).

### 3. Deploying the add-in (Exchange or Global admin)

Microsoft 365 admin center → **Settings → Integrated apps → Upload custom apps** →
app type *Office Add-in* → upload the manifest **file** (the URL option needs the
server to be reachable from Microsoft's cloud). Assign it to specific users or a
group. It can take up to 24 hours before the button appears in Outlook.

When `src/lib/outlook/manifest.ts` changes, bump `ADDIN_VERSION` and upload the new
file: the admin center keeps the file it was given. `manifest.test.ts` pins a hash
of the output to the version, so a change without a bump fails the tests. Changes
to the pane itself (`outlook-addin/src/`) need only a deploy.

### Working on the pane

`npm run build` builds the pane into `public/outlook-addin/` before `next build`,
but `npm run dev` does not build it at all. Run `npm run build:addin` once before
`npm run dev`, and again after every change under `outlook-addin/src/`, then
reload the pane. `public/outlook-addin/` is build output, not checked in.

## Why not just use the Teams toggle?

With Outlook's own **Teams-møde** toggle, the join link only exists once the meeting
is saved or sent. The add-in reads the invitation, so it has to be reopened after
that: save, reopen, press the button. Two ways round that were tried:

- **Arming on Send** (`OnAppointmentSend`, tested 2026-11-02 in Outlook on the web,
  Syddjurs tenant): Outlook does run the send event from the ordinary meeting form,
  but the Teams link is **not** in the body at Send, nor 1.5 s later. Outlook adds it
  after the send, to the stored item; the form the add-in reads never gets it. Dead
  end without reading the calendar (`Calendars.Read`), which we do not want.
- **Detecting the toggle**: Office.js has no API for it.

## Manifest 1.1: OS2taletiltekst as the meeting provider

So since manifest 1.1 the add-in can make the Teams meeting itself. It is an *online-meeting
provider* (Microsoft's "Create an Outlook add-in for an online-meeting provider",
the add-in type Zoom and Webex use). Microsoft documents that Outlook then shows the
provider **in place of its Teams toggle** on a new meeting. Switching ours on runs
`insertOs2Meeting` (`outlook-addin/src/provider.ts`), which:

1. refuses if the invitation already has a Teams link (so never two meetings),
2. calls `POST /api/outlook/online-meetings`: the server creates a Teams meeting
   for the subject and times (`POST /me/onlineMeetings`, the
   `OnlineMeetings.ReadWrite` scope we already have), then arms and registers it
   exactly like a link read from the invitation (`src/lib/outlook/arm-from-outlook.ts`),
3. appends the join link to the invitation, with a line saying the meeting is
   recorded and transcribed,
4. notes the meeting id on the appointment, so the pane can switch it off.

It is the same add-in (same id), version 1.1.0.0; the pane button stays. It needs
`ReadWriteItem` (it writes the link into the invitation); 1.0 had `ReadItem`.

**It must be admin-installed.** Microsoft: "Only admin-installed add-ins will appear
on the meeting compose screen, replacing the default Teams or Skype option.
User-installed add-ins won't activate." Moving from 1.0: Integrated Apps →
*OS2taletiltekst* → update it with the new `manifest.xml`. With
`OUTLOOK_ADDIN_ALLOWED_USERS` set, the server refuses everyone else regardless.

**Rolling back** to 1.0 = updating it with a 1.0 manifest again: `buildManifest()`
as of commit `98fd3ab`, for this host.

**Try it**, once the admin has updated it (it can take a while to appear):

1. New event. Does Outlook show *OS2taletiltekst* where the Teams toggle was, or
   both, or only a button in the ribbon?
2. Turn ours on (or press the ribbon button). A bar at the top of the form says
   what happened; the invitation gets a *Microsoft Teams-møde* block.
3. Add an attendee and send. Join the meeting from the link: it should record and
   transcribe by itself.
4. Also note: what happens when you switch ours off again, and whether the
   municipality's default (Teams on for every new meeting) still turns Teams on.

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
- The button is only on the organizer's meeting form (the manifest declares
  `AppointmentOrganizerCommandSurface` alone): an invitee never sees it. Someone
  who organizes the appointment in Outlook but not the Teams meeting behind its
  link (a pasted link, a delegate) gets the meeting registered, and the pane says
  the Teams organizer must start transcription.
- A recurring series is one Teams meeting. Switching OS2taletiltekst on for any
  occurrence sets automatic recording on that meeting, so Teams records every
  occurrence; only the ones switched on are fetched, and the other recordings stay
  in Teams. The pane says so on a recurring appointment, but does not refuse.
- Classic Outlook older than build 2409 and Office LTSC have no NAA; the pane says
  so, and the Mødelink box still works.
- A Conditional Access rule "Require approved client app" blocks NAA for its users.
