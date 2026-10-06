# Central templates (Phase 4)

Audience: operators who run the app and the "skabelonansvarlige" who manage templates, and engineers who change the code. Written against the code as it stands after Phase 4; where the original plan differs, the code is documented here. For roles, scope and the org tree see `README.md`; for the audit contract see `audit.md`.

## What a central template is

A central template is a minutes prompt (plus its four "include" flags) that a super user publishes to the people beneath them in the organisation. The recipients can use it to generate minutes, but they **cannot edit it, copy it or change what it does** unless the template explicitly allows a little room (see "Flags"). Only the managers can edit it, and every change is documented in a mandatory change note that becomes a permanent changelog.

It is separate from the personal templates that every user already has (`skabeloner` table in the per-user schema). Personal templates are unchanged; the two kinds sit side by side in the picker.

## Who may manage

- A **manager** is a principal holding `template.manage`: `tt-skabelonansvarlig` scoped to one or more org units, or `tt-administrator` (global). See `README.md` for how the scope is built. A `tt-skabelonansvarlig` without a unit has no scope and manages nothing.
- A template belongs to exactly one **owner unit** (`owner_org_unit_uuid`, set at creation, never changed afterwards: the update schema has no owner field). A manager may read, edit, archive and restore a template **iff `template.manage` covers the owner unit** (`isOrgUnitWithinScope`). Any manager whose scope covers the owner unit may edit it, not only the creator.
- Denial conventions follow `guard.ts`: no capability on the route gives 403; a template outside the caller's scope, an unknown id and an unknown owner unit on create all give 404 (existence is not revealed). Inside the service the two cases are the same `NotFoundError`, so the service fails closed even if a route forgot its guard.
- The admin routes work in both `ACCESS_SOURCE` modes. Templates are owned by this app; only the org tree they point at comes from Rollekatalog in `rollekatalog` mode.

## Delegation rules

- **Targets** are org units, each with `include_descendants` (default true). With it set, the template reaches the members of the target unit and of every unit below it; without it, only direct members.
- **Targets must lie inside the owner unit's subtree** (the owner itself included). A manager cannot delegate sideways or upwards; a unit outside the subtree, or one that does not exist, is rejected with 400 `target_outside_owner`. The check runs on every write that changes the targets.
- The owner/target pickers are fed by `GET /api/admin/central-templates/scope`, which returns only units inside the caller's scope. A parent that lies outside the scope is shown as `parentUuid: null`, so a scoped manager learns nothing about the tree above them.
- **Zero targets is allowed** (a draft that reaches nobody). The UI shows a warning badge "Ingen modtagere"; there is no default central template.
- Targets are checked against the owner subtree only **at write time**. If a unit is later moved out of the owner's subtree (for example by a Rollekatalog sync), it stays a recipient until a manager retargets. Check the template after a re-organisation.

## Who receives a template

`src/lib/skabeloner/resolve.ts` computes this on every request (no cache). A user receives a template iff all of these hold:

1. the template is `active` (archived templates are never listed and never usable);
2. the user is linked to a **non-disabled** directory user (`directory_users.app_user_id`, `disabled = false`);
3. that directory user is a member (`org_unit_members`) of a target unit, or of a descendant of a target unit whose `include_descendants` is true.

Implementation: one parameterised, schema-qualified query with a recursive upward walk from the user's own units (`UNION` plus the `MAX_ORG_DEPTH` cap of 64, like `scope.ts`), so the cost follows the user's ancestry chain rather than the size of the tree. A cycle in bad data terminates; an ancestor more than 64 hops up is not covered.

**Fail closed.** A user with no directory row, an unlinked row or a disabled row receives nothing. In local mode the link is set explicitly by an administrator; email addresses are never used to link (see `README.md`).

**Stale membership caveat.** Recipient resolution reads the mirrored membership as it is. In `rollekatalog` mode a person who moved or left keeps receiving the template until the **next successful sync** removes the membership or disables the user. `ROLE_STALE_MAX_SECONDS` applies to role assignments only, not to membership, and the resolver does not look at it. If the sync fails for days, membership is as old as the last good run. In local mode membership changes take effect immediately when an administrator edits the unit.

Note the resolver does not check roles: a recipient needs no role, not even the baseline `tt-bruger`, and `REQUIRE_ROLE_TO_LOGIN` does not affect it. A disabled directory user is the only thing that cuts off a recipient besides unit membership.

## The lock: what the server enforces

The real enforcement is in `POST /api/minutes` (`src/app/api/minutes/route.ts`), not in the UI.

- The request may carry `skabelonSource` (`'personal'` default, or `'central'`; anything else is 400 "Ugyldig skabelonkilde"). For `'central'` the server calls `resolveCentralTemplate(userId, skabelonId)`.
- If that returns nothing, the answer is **404** `{"error":"Skabelonen er ikke tilgængelig"}`, identical for an unknown id, a non-uuid or missing id, an archived template and a user who is not a recipient. There is no fall back to a personal or default template. A database failure while resolving is a 500, not a 404.
- The server uses the **stored prompt** and the **stored flags**. The client's `customPrompt` is passed on only if the template has `allow_user_instruction`; the client's `include*` flags only count if it has `allow_toggle_overrides` (and they must be booleans). Otherwise they are ignored without an error.
- The response is `{ content, skabelonId, templateRef }`. `templateRef` is `{ source: 'personal'|'central'|'none', id, version }`; for central `skabelonId` is the central id, and `version` is the template version used. Behaviour for personal, default and no template is unchanged (the default personal template still applies when `skabelonId` is omitted).

What the UI does on top (advisory, the server does not rely on it):

- `TranscriptReview` shows a "Centrale skabeloner" group with a lock icon and `v<version>`. The category toggles are seeded from the template and disabled ("Låst af din organisation") unless it allows overrides; the free-text instruction box is hidden unless it allows an instruction; "Gem prompt som skabelon" is hidden for a central template.
- Arkiv > Skabeloner has a read-only section "Centrale skabeloner (låst)" with no buttons (no edit, delete, share, default).
- A 404 from `/api/minutes` for a central template shows "Skabelonen er ikke længere tilgængelig. Vælg en anden skabelon.", refetches the list and clears the selection if the template is gone.

**Personal-template machinery never touches central templates.** `PUT/DELETE /api/skabeloner/[id]`, `.../default`, `.../share` and the import routes work on the per-user `skabeloner` table only, so a central id is a plain 404 there (`central-isolation.test.ts`, which also checks that the personal routes do not import the manager service). Share code, share link and "save as personal template" are not offered for central templates.

## Flags

| Flag (default off) | Effect when on |
|---|---|
| `allow_user_instruction` | The recipient may type a free-text instruction in the review screen. It is appended to the locked prompt (via `customPrompt`). Managers should know this lets a recipient add text after the prompt; it is by design. |
| `allow_toggle_overrides` | The recipient may switch the four categories (deltagere, beslutningspunkter, dagsorden, dato) on or off instead of getting the stored values. |

Both default to false per template and are set by the manager in the editor ("Dette gemmer du" summary and helper texts explain them).

## Prompt confidentiality

**Default: ordinary users never receive the text of a central prompt.** This is structural, not a UI choice:

- `GET /api/skabeloner` returns `centralSkabeloner: CentralSkabelonSummary[]` (id, name, description, four flags, `locked: true`, `version`, the two allow flags). `CentralSkabelonSummary` has no `prompt` field, and the SQL behind it does not select the column.
- Only `resolveCentralTemplate` reads the prompt, returns it as the separate server-internal `ResolvedCentralTemplate`, and `/api/minutes` hands it to the model. It is not in the response, not in error bodies, not in logs and not in audit events (tests assert this).
- The prompt text appears only in the manager routes under `/api/admin/central-templates`, whose responses carry `Cache-Control: no-store`.

Honest limits: the prompt is sent to the AI provider like any prompt, and generated minutes can echo parts of it. Confidentiality here means the app does not show or return the prompt to recipients, not that the model's output can never reveal it.

**How to flip it** (if transparency is preferred): there is no setting; it is a code change. Add `ct.prompt` to `SUMMARY_COLUMNS` and `summaryOf` in `resolve.ts`, add `prompt` to `CentralSkabelonSummary` in `central-types.ts`, show it in `TranscriptReview.tsx` / `SkabelonerList.tsx`, and update the tests that assert its absence (`resolve.test.ts`, `src/app/api/minutes/route.test.ts`, `src/app/api/skabeloner/route.test.ts`, `TranscriptReview.test.tsx`, `SkabelonerList.test.tsx`). Decide first whether recipients may also copy it into a personal template; if so, that is a further change.

## Change notes, versioning and concurrency

- **Every write needs a change note**, for every change type (create, update, retarget, archive, restore). The server trims it and requires **10 to 2000 characters** (counted as code points, like Postgres `char_length`), with the message "Beskriv ændringen (mindst 10 tegn)". The table also has a CHECK, so a note cannot be bypassed by writing SQL directly.
- `central_templates.current_version` starts at 1. Each write bumps it by one and appends a row to `central_template_versions` carrying: version, `change_type` (`create`, `update`, `retarget`, `archive`, `restore`), the note, who (`changed_by_user_id` without a foreign key, plus `changed_by_name` as a **snapshot** of the name at the time), when, and full snapshots of the content and the targets.
- `change_type` is `retarget` when only the targets changed, otherwise `update`. An update that changes nothing is rejected (400 `no_changes`) instead of writing an empty version.
- **One transaction per write** (`central.ts`): the template row and its targets, the version row and the audit event are committed together. `recordEvent` is called with the transaction and throws, so a failed audit write rolls the whole change back.
- **Optimistic concurrency.** Updates, archive and restore carry `baseVersion`. The row is locked `FOR UPDATE`, the version is compared, and the `UPDATE` is also filtered on `current_version`. A mismatch is **409** with code `version_conflict` and `currentVersion` in the body (`VersionConflictError`). Two concurrent writers with the same `baseVersion`: exactly one wins.
- The UI handles a conflict by blocking the save, showing "Skabelonen er ændret af en anden (version N)", and offering "Genindlæs", which shows the saved version next to the user's text as a diff. There is no field-level merge: a second explicit save sends the whole form against the new `baseVersion`, so a field someone else changed that you did not touch is written back to your older value (the dialog says so).
- An **archived template cannot be edited** (409 `template_archived`): restore it first. This is a deliberate choice and easy to flip in `updateCentralTemplate`.

## Append-only history

`central_template_versions` is the changelog and is append-only. Migration `0003_central_templates` ends with a hand-appended plpgsql function and two triggers that refuse `UPDATE` and `DELETE` (per row) and `TRUNCATE` (per statement) with SQLSTATE `55000`. Unlike the audit table there is **no prune bypass**: nothing in the app ever deletes a version.

Because the foreign key from versions to templates is `ON DELETE CASCADE` and cascaded deletes fire the row trigger, even a manual `DELETE FROM central_templates` for a template that has versions (all of them do) is refused.

Honest limits, the same as `audit_events`: this guards against bugs and casual misuse. A database superuser or the table owner can drop the triggers, and the app's own database role normally owns the tables. If you need tamper evidence against an operator, forward the audit events to a SIEM (`audit.md`): each write there records the template id, the new version number and the changed field names, which is enough to notice a missing or rewritten version, though not to restore the notes.

## Archive, not delete

There is no hard delete anywhere. `POST .../archive` sets `status = 'archived'` and `POST .../restore` sets it back to `active`, each with a note and a new version. An archived template disappears for recipients at once and cannot generate (the resolver answers 404), but it stays in the manager list under `?status=archived` (or `all`) with its full history. Minutes already generated keep their provenance (see below).

**Org units that own templates cannot be deleted.** `owner_org_unit_uuid` is a `RESTRICT` foreign key, and `deleteOrgUnit` (`access-admin.ts`) answers 409 `has_central_templates` ("Enheden ejer centrale skabeloner og kan ikke slettes. Skabeloner kan arkiveres, men ikke slettes.") and also maps SQLSTATE 23001 to a conflict. Archiving does not release the unit: an archived template still has an owner. Targets use `ON DELETE CASCADE`, so deleting a target unit just removes it from the recipient list. The Rollekatalog sync never deletes org units (see `rollekatalog.md`), so this block only affects units deleted by a local administrator.

## Provenance: which prompt produced these minutes?

- **With the minutes.** The browser stores `templateRef` (`{ source, id, version }` plus the template name as it was in the picker) with the minutes row in IndexedDB (`StoredMinutes`). The minutes screen shows "Skabelon: <navn> (central, v3)". A regeneration replaces it. It is the latest generation's reference, not one per minutes version, and the name does not follow a later rename.
- **In the audit log.** Every `minutes.generate` event carries `templateSource: 'central'`, `templateVersion` and the central template uuid as the secondary entity (type `central_template`). The audit log never holds the name or prompt.
- The question "which prompt produced this?" is answered by the version number: open the changelog for that template and read version N, which has the full prompt snapshot.

## Who can read what

| What | Who |
|---|---|
| Prompt, flags, targets, owner, changelog (`/api/admin/central-templates/**`) | managers: `template.manage` whose scope covers the owner unit; global `tt-administrator` sees all |
| Name, description, flags, version of the templates a user receives | the recipient (no prompt) |
| Audit events `central_template.*` (ids, versions, field names) | holders of `audit.read` within their scope, as for any audit event |
| Change notes | only in the changelog, never in the audit log |

Reading the prompt or the changelog is **not** itself audited (only writes are). A manager outside the owner's scope gets 404 for the template and its versions.

## API reference

Manager routes, all `withAuthz(..., 'template.manage')`, no `requireLocalSource`, strict zod bodies (`central-schemas.ts`), responses `no-store`. Service errors map to: 404 not found or out of scope, 400 validation, 409 conflict. A 400 body is `{ error, code: 'invalid', issues: [{ path, code, message? }] }`; only our own Danish messages are forwarded.

| Route | Body / query | Success |
|---|---|---|
| `GET /api/admin/central-templates` | `?status=active` (default) `\|archived\|all` | `{ templates: CentralTemplateListItem[] }`, only owners in scope |
| `POST /api/admin/central-templates` | `{ ownerOrgUnitUuid, name, prompt, description?, include*, allowUserInstruction?, allowToggleOverrides?, targets?, changeNote }` | 201 `{ template }` |
| `GET /api/admin/central-templates/[id]` | | `{ template: CentralTemplateAdmin }` |
| `PUT /api/admin/central-templates/[id]` | `{ baseVersion, changeNote, ...partial content, targets? }` | `{ template }`; `targets` replaces the whole list |
| `POST .../[id]/archive` | `{ baseVersion, changeNote }` | `{ template }` |
| `POST .../[id]/restore` | `{ baseVersion, changeNote }` | `{ template }` |
| `GET .../[id]/versions` | | `{ versions: CentralTemplateVersion[] }`, newest first |
| `GET .../scope` | | `{ orgUnits: [{ uuid, name, parentUuid }] }` inside the caller's scope |

There is no `DELETE` export, so the platform answers 405. A malformed `[id]` is 400. Limits: name 120, description 1000, prompt 20000, change note 10 to 2000, at most 200 targets (deduplicated by unit, first wins).

User routes:

| Route | Contract |
|---|---|
| `GET /api/skabeloner` | `{ skabeloner: Skabelon[] (personal, unchanged), centralSkabeloner: CentralSkabelonSummary[] }`. If resolving the central list fails, it is logged (`safeLogError`) and returned empty; the personal list is not affected |
| `POST /api/minutes` | adds `skabelonSource`, returns `templateRef`; see "The lock" |

The admin UI is `/admin/skabeloner` (section key `templates`, label "Centrale skabeloner", visible to `template.manage`; `tt-skabelonansvarlig` and `tt-administrator`). Components are in `src/components/admin/` (`CentralTemplatesAdmin`, `CentralTemplateEditor`, `OrgUnitTargetPicker`, `TemplateVersionHistory`, `CentralTemplatesStateDialog`, `CentralTemplatesChangeNote`). Rediger is hidden for archived templates; Historik shows each version with a line diff of the prompt against its predecessor.

## Worked example

A municipality has `Kommunen` with two departments, `Børn og Unge` and `Teknik og Miljø`, each with teams below.

1. An administrator gives Anna the role `tt-skabelonansvarlig` scoped to `Børn og Unge` with descendants (in Rollekatalog mode that is an IT-system role with the unit as data constraint; in local mode it is assigned in `/admin/brugere`).
2. Anna opens `/admin/skabeloner`, clicks "Ny central skabelon", picks `Børn og Unge` as owner (the only unit she can pick, along with its sub-units), writes the prompt, leaves both allow flags off, picks target `Børn og Unge` with "inkl. underenheder", and writes the note "Første version af referatskabelon til børnemøder". The template is v1, active, and reaches every linked, enabled member of `Børn og Unge` and its teams.
3. Bo, in a team under `Børn og Unge`, opens the review screen and sees "Centrale skabeloner" with a lock and `v1`. The toggles are locked. He generates minutes; `templateRef` is `{ central, <id>, 1 }` and the audit event says `templateVersion: 1`. Bo cannot see the prompt text. Cecilie in `Teknik og Miljø` sees nothing.
4. Anna tightens the prompt, enabling `allow_user_instruction`, with the note "Tillader egne instruktioner efter klage over for stiv skabelon". It becomes v2 (`update`; the audit event lists `changedFields: [prompt, allowUserInstruction]` without values). Bo's next generation records v2.
5. A colleague, Dorthe, also `tt-skabelonansvarlig` for `Børn og Unge`, opens the template while Anna saves; Dorthe's save returns 409 `version_conflict` with `currentVersion: 2`; she reloads, sees Anna's diff and saves again as v3.
6. Anna tries to add `Teknik og Miljø` as target: 400 `target_outside_owner`. A template can only reach `Teknik og Miljø` if its owner unit contains it, for example one owned by `Kommunen`, which only a manager whose scope covers `Kommunen` (or a global `tt-administrator`) can create or edit.
7. Anna archives the template when it is no longer wanted (v4, `archive`). Recipients lose it immediately; `Børn og Unge` can still not be deleted, because it owns the template.

## Known limitations

- **Personal templates are still allowed.** A recipient can ignore the central template and use or write a personal one. A "central templates only" policy per org unit is not implemented.
- **No per-template default.** A central template is never preselected; the default personal template mechanism is untouched.
- **Share code is client-side and personal only.** It is built in the browser from a personal template and does not apply to central templates.
- **Provenance is partial.** Minutes generated before Phase 4 have no `templateRef`. The reference lives in the browser's IndexedDB with the minutes (so it is lost with the browser data), shows the latest generation only, and its name does not follow renames. The authoritative record is the audit event (id and version) plus the changelog.
- **Stale membership** (see above) and **no re-check of the owner subtree at read time**.
- **Older `/api` routes check only the session.** `/api/minutes` does not consult the principal (no `template.use` check, no `authz.denied` events); the recipient check is its own.
- **A free-text instruction can be appended** when `allow_user_instruction` is on; the model sees both.
- **An unresolvable central template is a 404** that the review screen turns into a clear message; an infrastructure error while resolving is a 500.
- **Not exercised against a real database or browser.** `central.pg.test.ts` and `resolve.pg.test.ts` (gated by `TEST_DATABASE_URL`, PostgreSQL 15+) were written without a database and have not been run; neither has the migration been applied to a real instance. The recursive query, the append-only triggers, the concurrency test and the `RESTRICT` foreign key are therefore unproven against Postgres. The admin UI and the review screen were tested only with jsdom and mocked `fetch`. Run `TEST_DATABASE_URL=postgres://... npx vitest run src/lib/skabeloner` and try the feature in a browser before relying on it.
