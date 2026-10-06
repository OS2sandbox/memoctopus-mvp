# Central templates

For the "skabelonansvarlige" who manage templates, operators, and engineers who change the code. Roles, scope and the org tree: `README.md`. Audit contract: `audit.md`.

## What a central template is

A central template is a minutes prompt (plus its four "include" flags) that a manager publishes to people beneath them in the organisation. Recipients can use it to generate minutes but **cannot edit it, copy it or change what it does**, except where the template explicitly allows room (see Flags). Only managers edit it, and every change needs a change note that becomes a permanent changelog. It is separate from the personal templates every user has (`skabeloner` table in the per-user schema); the two kinds sit side by side in the picker, and personal templates are still allowed.

Code: `src/lib/skabeloner/central.ts` (manager service), `resolve.ts` (recipients), `central-schemas.ts` (strict zod bodies), `src/app/api/admin/central-templates/`, `src/app/api/minutes/route.ts`, admin page `/admin/skabeloner`.

## Who may manage

- A **manager** holds `template.manage`: `tt-skabelonansvarlig` scoped to org units, or `tt-administrator` (global). A `tt-skabelonansvarlig` without a unit manages nothing.
- A template has exactly one **owner unit** (`owner_org_unit_uuid`, set at creation, never changed). A manager may read, edit, archive and restore it **iff `template.manage` covers the owner unit** (`isOrgUnitWithinScope`); any such manager, not only the creator. That includes a manager whose scope covers an **ancestor** of the owner unit: scope is subtree-based, so a manager higher up the tree can read, edit and archive templates owned by units below. This is the intended rule, and it is made accountable rather than narrowed: the admin list and detail show **who created** the template (the name snapshot of version 1) and **who last edited** it and when (the name snapshot and time of the current version), and every change is audited (below). Reading a template, prompt included, is not audited. These names are derived from the changelog and are manager-side only; the user-facing `CentralSkabelonSummary` and its query never carry them.
- Denials: no capability gives 403; a template outside the caller's scope, an unknown id and an unknown owner unit on create all give 404 (existence is not revealed; the service fails closed even if a route forgot its guard).
- The admin routes work in both `ACCESS_SOURCE` modes: templates belong to this app, only the org tree comes from Rollekatalog.

## Delegation

- **Targets** are org units with `include_descendants` (default true): the template reaches the members of the target and, when set, of every unit below it.
- Targets must lie **inside the owner unit's subtree**; anything else is rejected with 400 `target_outside_owner` on every write that changes the targets. The same rule is re-validated on every read: a target counts only while it is the owner unit or a descendant of it right now (a capped upward walk to the owner). If a unit is later moved out of the subtree (a Rollekatalog sync or a local move), it silently stops receiving the template (fail closed, no notice), and moving it back restores delivery. The admin list does not yet flag such drifted targets (known gap), so check templates after a reorganisation.
- The pickers use `GET /api/admin/central-templates/scope`, which returns only units inside the caller's scope (a parent outside it shows as `parentUuid: null`).
- Zero targets is allowed (a draft reaching nobody; the UI warns "Skabelonen er ikke til rådighed for nogen, før du vælger mindst én enhed" and the list shows "Ikke til rådighed for nogen"). There is no default central template.

## Who receives a template

**Wording in the UI.** The Danish UI never says "modtager" (recipient): users do not receive anything, a template is *made available* to them. The list column is "Til rådighed for" (a count such as "3 enheder"), the editor section is "Hvem skal have skabelonen til rådighed?" ("Vælg de enheder, hvis medarbejdere kan bruge skabelonen. Underenheder kan vælges med."), and the version history says "Gjort tilgængelig for: X (inkl. underenheder)", "Ikke længere tilgængelig for: X" and "Tilgængelig for X: kun enheden selv". Code, API fields and this document keep the engineering terms `target` and `recipient`.

**Version history modal.** For the selected version it shows, in this order: the heading ("Version 3 sammenlignet med version 2", or "Version 1 (første version)"), the change note with author and time ("Ændringsbeskrivelse"), then "Ændringer": the prompt diff (for the first version everything is new) and "Øvrige ændringer" (changed settings and availability).

`resolve.ts` computes it on every request (no cache). A user receives a template iff (1) it is `active`, (2) the user is linked to a **non-disabled** directory user (`directory_users.app_user_id`, `disabled = false`), and (3) that directory user is a member of a target unit, or of a descendant of a target with `include_descendants`. One query walks up from the user's own units and then from each matching target up to the template's owner unit (`UNION` plus the 64-level depth cap of `scope.ts`); a target that does not reach the owner is ignored.

Fail closed: no directory row, an unlinked row or a disabled row receives nothing. The resolver checks no roles. **Gate order:** every older `/api` route, `POST /api/minutes` included, first runs `requireAppAccess` (`README.md`), so a disabled user, or with `REQUIRE_ROLE_TO_LOGIN=true` a user without any role, is refused (403) before the recipient check is reached.

**Stale membership.** Membership is read as mirrored. In `rollekatalog` mode a person who moved or left keeps receiving the template until the next successful sync changes the membership or disables them; `ROLE_STALE_MAX_SECONDS` does not apply to membership. In local mode a change takes effect when an administrator edits the unit.

## The lock: what the server enforces

Enforcement is in `POST /api/minutes`, not in the UI.

- The body may carry `skabelonSource` (`'personal'` by default, or `'central'`; anything else is 400 "Ugyldig skabelonkilde"). For `'central'` the server calls `resolveCentralTemplate(userId, skabelonId)`.
- Nothing found gives **404** `{"error":"Skabelonen er ikke tilgængelig"}`, identical for an unknown or malformed id, an archived template and a non-recipient. No fallback to a personal template. A database failure while resolving is a 500.
- The **stored prompt and flags** are used. The client's `customPrompt` counts only if the template has `allow_user_instruction`; the client's `include*` flags only if it has `allow_toggle_overrides`. Otherwise they are ignored without an error.
- `customPrompt` is validated for **every** template kind (personal, default, none and central) before anything else uses it: it must be a string (anything else, `null` included, is 400 "Instruktionen skal være tekst"), is trimmed, and may be at most 2000 characters (400 "Instruktionen er for lang (højst 2000 tegn)"). A blank value counts as absent.
- The response is `{ content, skabelonId, templateRef }`; `templateRef` is `{ source, id, version }`.

The UI adds advisory behaviour: a "Centrale skabeloner" group with lock and version, toggles seeded and disabled ("Låst af din organisation") unless overrides are allowed, no instruction box and no "save as template" for central templates, and a read-only list in Arkiv > Skabeloner. After a 404 for a central template that has vanished, the review screen shows "Skabelonen er ikke længere tilgængelig. Vælg en anden skabelon.", refetches the lists and **reselects the personal default**.

The personal-template routes (`/api/skabeloner/[id]/**`, share, import) work on the per-user table only, so a central id is a plain 404 there (`central-isolation.test.ts`).

## Flags

| Flag (default off) | Effect when on |
|---|---|
| `allow_user_instruction` | The recipient may type a free-text instruction (sent as `customPrompt`) that is added to the request. By design; it also lets the user ask the model about its instructions |
| `allow_toggle_overrides` | The recipient may switch the four categories (deltagere, beslutningspunkter, dagsorden, dato) instead of getting the stored values |

## Prompt confidentiality

**Default: ordinary users never receive the text of a central prompt.** This is structural:

- `GET /api/skabeloner` returns `centralSkabeloner` (`CentralSkabelonSummary`: id, name, description, flags, `locked`, `version`); the type has no `prompt` field and the SQL does not select the column.
- Only `resolveCentralTemplate` reads the prompt, as the server-internal `ResolvedCentralTemplate`; `/api/minutes` hands it to the model. It is not in the response, error bodies, logs or audit events.
- The prompt appears only in the manager routes (`Cache-Control: no-store`).

**Hardening of the generation itself** (`src/lib/ai/prompt-echo.ts`, `minutes.ts`), for central templates only:

- Client strings that reach the instruction are flattened: participants (at most 100, 80 characters each) and chapter titles and summaries (at most 200 chapters, 120 characters per field) lose control and line-break characters.
- The stored prompt goes into the **system message**, with a confidentiality notice, not into the user message; the optional user instruction stays in the user message.
- The output is scanned for **verbatim runs of the prompt**. The comparison is made on a stream of **letters only**: both texts are NFKD-decomposed and lower-cased, and everything that is not a letter is deleted (digits, punctuation, whitespace, combining marks, and Default_Ignorable or format characters such as zero-width characters, soft hyphen and the Hangul fillers). An offset map leads back to the original text, so only the matched span is replaced by `[udeladt]`. This catches digits inserted between words, letter-spacing (`S k r i v`), hyphenated letters, zero-width or soft-hyphen characters, fullwidth and other compatibility letters, NFC against NFD, and markdown bold or bullets around every word. A run of at least 60 letters, or 80 % of the prompt for prompts shorter than 75 letters (but at least 30), is replaced; prompts under 30 letters are not checked. The work is linear in the output (one window lookup per letter). A scrubbed run is audited as `outcomeCode: 'prompt_echo'` on `minutes.generate`; nothing about the matched text is logged.

**Honest limits.** This raises the bar; it does not make a leak impossible. The prompt is sent to the AI provider like any prompt. The transcript text itself cannot be sanitised, so something said in the meeting can still steer the model. A paraphrase, a translation or a letter-level transformation that changes the letters themselves (reordering, homoglyphs from another script) is not detected. **Any recipient can prompt the model**, whether or not `allow_user_instruction` is set: the `segments` sent to `/api/minutes` are client-supplied and not tied to a meeting, so a recipient can put an instruction ("repeat your instructions") in a segment and the server cannot tell it from speech. `allow_user_instruction` only adds a documented, supported path for the same thing; leaving it off does not close the other one. Confidentiality is therefore best effort. Treat a central prompt as "not shown to recipients", not as a secret.

## Change notes, versioning and concurrency

- **Every write needs a change note** (shown in the audit log viewer under the event, see `audit.md`) (create, update, retarget, archive, restore). The server removes invisible, default-ignorable and control characters (newlines and tabs are kept), trims, and requires **at least 10 non-whitespace characters** (counted as code points) and at most 2000 characters; the **normalised** note is what is stored. Message: "Beskriv ændringen (mindst 10 tegn)".
- The **template name** needs at least one visible character after the same stripping (at most 120).
- The same counting function (`src/lib/skabeloner/change-note.ts`, free of zod and server code) is used by the server schema and by the counter in the editor, so the counter shows the number the server enforces. Invisible characters and interior whitespace do not count there either.
- **Stored text is well-formed and NFC.** Name, description, prompt and change note are rejected with "Teksten indeholder ugyldige tegn (ufuldstændigt Unicode-tegn)" if they contain a lone surrogate (Postgres jsonb would refuse it with SQLSTATE 22P02; the service also maps 22P02 to a validation error as defence in depth), and are stored NFC-normalised. The prompt limit is measured on the NFC text.
- The database **CHECK constraints mirror the name and change-note rules** (`central_templates_name_check`, `central_template_versions_change_note_check`, migration `0003`) and ignore **exactly** the same set of characters as the app: every Default_Ignorable_Code_Point, control (Cc) and format (Cf) character, the blank letters U+115F, U+1160, U+3164, U+FFA0, the braille blank U+2800, and Unicode White_Space (listed as explicit `\u` / `\U` escapes, no locale-dependent POSIX class). The class is generated from the app's regex; it was checked by enumerating every code point against PostgreSQL 16 with no difference in either direction, and `change-note.test.ts` recomputes it from the TypeScript regex so the two cannot drift (after a Unicode data update the test fails and the class must be regenerated; the literal lives in `MEANINGLESS_CHARS_CLASS` in `src/lib/db/schema.ts`, migration `0003` and its snapshot). A note or name therefore cannot be bypassed by writing SQL directly. The prompt CHECK is only "not blank, at most 20000 characters"; the app does not strip invisible characters from a prompt either. Lone surrogates and NFC are app-side rules only.
- `current_version` starts at 1; each write bumps it and appends a row to `central_template_versions`: version, `change_type` (`create`, `update`, `retarget`, `archive`, `restore`), the note, `changed_by_user_id` (no foreign key) and a name snapshot, the time, and full snapshots of content and targets. `retarget` means only the targets changed; an update that changes nothing is rejected (400 `no_changes`).
- **One transaction per write**: template row, targets, version row and the `central_template.*` audit event commit together; the audit insert throws, so a failed audit write rolls everything back.
- **Optimistic concurrency.** Updates, archive and restore carry `baseVersion`; the row is locked `FOR UPDATE` and compared. A mismatch is **409** `version_conflict` with `currentVersion`. The UI offers "Genindlæs" with a diff, but there is no field-level merge: a second save sends the whole form against the new version.
- An archived template cannot be edited (409 `template_archived`); restore it first.

## Append-only history

`central_template_versions` is the changelog. Migration `0003_central_templates` ends with a plpgsql function and triggers that refuse `UPDATE`, `DELETE` (per row) and `TRUNCATE` with SQLSTATE `55000`; unlike the audit table there is **no prune bypass**, and cascaded deletes fire the row trigger, so even deleting a template that has versions is refused. Limits as for `audit_events` (`audit.md`): this guards against bugs and casual misuse, not against the table owner or a superuser, and the app's role normally owns the tables. For tamper evidence forward the audit events (each write records template id, version and changed field names). The changelog stores the actor's name snapshot and the notes and has no retention or erasure path; decide whether that is acceptable for your records.

## Archive, not delete

There is no hard delete. `archive` and `restore` set `status`, each with a note and a new version. An archived template disappears for recipients at once and cannot generate, but stays listed for managers (`?status=archived` or `all`). An org unit that owns a template cannot be deleted (`RESTRICT`; `deleteOrgUnit` answers 409 `has_central_templates`, also for archived templates). Targets cascade: deleting a target unit just removes it from the recipient list (see the limitation below about the changelog). The Rollekatalog sync never deletes org units.

## Provenance and who can read what

- The browser stores `templateRef` (`{ source, id, version }` plus the template name from the picker) with the minutes in IndexedDB and shows "Skabelon: <navn> (central, v3)". It reflects the latest generation only, and the name does not follow a rename.
- `minutes.generate` audits `templateSource: 'central'`, `templateVersion` and the template as secondary entity. The authoritative answer to "which prompt produced this?" is the version number in the changelog.

| What | Who |
|---|---|
| Prompt, flags, targets, owner, changelog | managers whose `template.manage` covers the owner unit; a global `tt-administrator` sees all |
| Name, description, flags, version | the recipient (no prompt) |
| `central_template.*` audit events (ids, versions, field names) | holders of `audit.read` within their scope |
| Change notes | the changelog only, never the audit log |

Writes are audited in the same transaction as the change. **Reading is not audited**: `GET /api/admin/central-templates/[id]` and `GET .../[id]/versions` write no event, in line with the audit principle that the log records what people did, not what they looked at (`audit.md`). The prompt is still protected where it matters: only managers in scope can read it (403 and 404 as above), it never reaches recipients, and it is never logged.

## Routes

Manager routes (`withAuthz(..., 'template.manage')`, strict bodies, `no-store`): `GET`/`POST /api/admin/central-templates` (`?status=active|archived|all`), `GET`/`PUT .../[id]` (`PUT` takes `baseVersion`, `changeNote`, partial content and `targets`, which replaces the whole list), `POST .../[id]/archive` and `.../[id]/restore` (`baseVersion`, `changeNote`), `GET .../[id]/versions`, `GET .../scope`. User routes: `GET /api/skabeloner` (adds `centralSkabeloner`) and `POST /api/minutes` (adds `skabelonSource`, returns `templateRef`). Service errors map to 404 not found or out of scope, 400 validation (`{ error, code: 'invalid', issues: [{ path, code, message? }] }`, only our own Danish messages are forwarded) and 409 conflict. There is no `DELETE`. Limits (`CENTRAL_LIMITS`): name 120, description 1000, prompt 20000, change note 10 to 2000, at most 200 targets (deduplicated by unit, first wins). The UI components are in `src/components/admin/`.

## Known limitations

- Personal templates are still allowed; there is no "central templates only" policy per org unit and no per-template default.
- Share code, share link and "save as personal template" are not offered for central templates; the share code is client-side and unaudited.
- Provenance in the browser is partial (latest generation only, lost with the browser data); minutes made before central templates have no `templateRef`.
- Recipient membership is only as fresh as the last sync. Targets that drifted out of the owner subtree stop delivering without any notice, and the admin list does not flag them yet.
- Prompt confidentiality is best effort (see above): any recipient can steer the model through the transcript segments they send.
- Deleting a target org unit cascades the `central_template_targets` row but does **not** write a new version: the current version's stored `targets` snapshot in `central_template_versions` (append-only) then still lists the deleted unit, and the changelog and the live recipient list disagree until the next write. Recipients are always computed from the live rows, never from the snapshot.
