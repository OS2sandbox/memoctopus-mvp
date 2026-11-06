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

## Manifest 1.1: arming before the invitation is sent

In Outlook on the web and new Outlook, Outlook's own Teams toggle only creates the
Teams meeting, and puts its link in the invitation, when the meeting is **saved or
sent**. An add-in has no say after send (`OnAppointmentSend` runs before Outlook
adds the link: see "Why not just use the Teams toggle?"). So both entry points save
the meeting themselves when it has no link yet (`saveAndReadJoinLink()` in
`outlook-addin/src/meeting.ts`, Office.js `item.saveAsync`, Mailbox 1.3). Microsoft
documents that a new appointment saved this way goes to the organizer's calendar
**without invitations**. Then they read the body until Outlook's link appears (up to
about 15 s), and arm that meeting:

- the pane's **Slå OS2taletiltekst til**, now also offered on a meeting with no link;
- the menu command **Teams-møde med referat** (`insertOs2Meeting`,
  `outlook-addin/src/provider.ts`), the same without opening the pane, reporting in
  the form's notification bar.

Outlook's toggle must be on. If saving brings no link, both say so and fall back to
"send, reopen, Slå til". **Unverified against a real tenant**: whether Outlook on the
web creates its Teams meeting on an add-in's save as it does on the user's.

Neither makes a Teams meeting of its own any more. The first version of the menu
command did (`POST /api/outlook/online-meetings`, still on the server), but Outlook
shows its **Join** button only for meetings its own toggle made, or for provider
add-ins published in Microsoft's Marketplace, so attendees of ours got a bare link.

Manifest 1.1.0.0 (same id): the menu command, the pane button, and `ReadWriteItem`,
which `saveAsync` needs (1.0 had `ReadItem`). Outlook was documented to put a
provider add-in in place of its Teams toggle; on the web it shows up as a menu next
to the pane button instead. **It must be admin-installed.** Moving from 1.0:
Integrated Apps → *OS2taletiltekst* → update it with the new `manifest.xml`; it took
about a day to reach Outlook. **Rolling back** to 1.0 = updating it with a 1.0
manifest again: `buildManifest()` as of commit `98fd3ab`, for this host.

## When it does not work

**"Mødet har endnu intet Teams-link."** In new Outlook and Outlook on the web the
Teams link only lands in the meeting text once the meeting is saved or sent. Switch
Outlook's Teams toggle on and press the button: it saves the meeting first. If that
brings no link, send the invitation, open the meeting again from the calendar, and
press the button.

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
