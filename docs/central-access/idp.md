# Identity providers and roles from claims: operator guide

For the person who connects an installation to a municipality's (or region's) own identity provider and decides which login role means which app role. Architecture: `README.md`. Rollekatalog as a role source: `rollekatalog.md`.

## 1. What this gives you

- **One installation, its own IdP.** Every municipality has its own installation and its own IdP (FKA, Entra ID, OS2faktor, Authentik, ...). Nothing is shared between installations, and nothing is compiled in: the providers are described in **one JSON file** (`AUTH_CONFIG_FILE`). Changing it needs a restart, never a rebuild or a code change.
- **OIDC and SAML 2.0**, any number of providers side by side (one button each on the sign-in page).
- **Roles come with the login.** Rights are managed *outside* the app, in the IdP or upstream of it (for example OS2rollekatalog writing roles into the IdP). The IdP sends them along as claims (OIDC) or attributes (SAML), and the file says which claim value is which app role. The app has no role administration in this mode, and an administrator cannot be created in the app.

**Who controls the role attributes.** Everything in the claims is trusted: whoever can change the claim that carries the roles or groups at the IdP can give themselves any role here. The role and group attributes must therefore be **set by the IdP's administrators only** (assigned from a directory group, an app-role assignment or an upstream role system), never copied from a field a person or a department can edit themselves (a free-text profile attribute, a self-service group). Also decide who may *create* groups or app roles that share a name with a mapped value. Entra group GUIDs and app role values only mean something inside one tenant, which is why the app refuses a multi-tenant Entra setup (section 5).

What the app **cannot** know without the municipality: which protocol their IdP speaks to this solution, and the *names* of the claims or attributes that carry user id, e-mail, name, roles and groups. Every recipe below marks those as **ask the municipality**; do not guess them, a wrong claim name does not fail loudly, it just means nobody gets a role.

## 2. Quick start

`auth-config/auth.json` (the directory is mounted read-only at `/config`; it is git-ignored because it may hold secrets):

```json
{
  "providers": [
    {
      "type": "oidc",
      "id": "kommune",
      "label": "Kommunens login",
      "clientId": "referat",
      "clientSecret": "${KOMMUNE_CLIENT_SECRET}",
      "discoveryUrl": "https://login.kommune.example/.well-known/openid-configuration",
      "scopes": ["openid", "profile", "email"],
      "rolesClaim": "roles"
    }
  ],
  "roles": {
    "appRoleMap": {
      "referat-administrator": "tt-administrator",
      "referat-skabelon": "tt-skabelonansvarlig",
      "referat-log": "tt-logleser",
      "referat-bruger": "tt-bruger"
    }
  }
}
```

This is the one-provider form. With several providers each one gets its own maps under `roles.byProvider.<id>` (section 3.4).

`.env`:

```bash
AUTH_CONFIG_FILE=/config/auth.json
ACCESS_SOURCE=claims
KOMMUNE_CLIENT_SECRET=...        # forwarded to the container, see section 9
# Leave these two BLANK: claims mode is closed by default (see section 4).
# EMAIL_PASSWORD_ENABLED=
# REQUIRE_ROLE_TO_LOGIN=
```

`BETTER_AUTH_URL` must be the public **https** URL of the installation; in production an OIDC or SAML provider is skipped without it, and every IdP URL in the file has to be https (`http` is accepted for `localhost` / `127.0.0.1` outside production only).

Register the redirect URI with the IdP (`<BETTER_AUTH_URL>/api/auth/oauth2/callback/kommune`), `docker compose up -d app`, sign in. Look at the app log: every skipped provider and an unusable `roles` section are reported (section 8).

## 3. The config file

Three optional top-level sections: `providers`, `roles`, `catalogue`. An unknown top-level key (a misspelt `roles`, for instance) makes the whole `roles` section unusable, see "Failure behaviour".

`${NAME}` in any string **value** (not in object keys) is replaced from the environment of the app process. A variable that is unset or blank makes that provider (or section) invalid. The file is read **once at start**; the sign-in page and the server read the same copy, so they cannot disagree.

### 3.1 Provider fields

Common to all types: `type` (`oidc` | `entra` | `saml`), `id`, `label` (button text: "Fortsæt med <label>"), `enabled` (default `true`; `false` skips the entry), `rolesClaim`, `groupsClaim`.

`id` becomes part of the callback URL **and** the key that ties people to their accounts: lower-case letters, digits, `_` and `-`, at most 40, and never `microsoft`, `credential`, `password` or `unknown` (built-in providers and the audit log's placeholders). **Pick it once.** Renaming it after go-live gives returning users a new, empty account.

**`oidc`** (any compliant IdP: Keycloak, Authentik, FKA, ...)

| Field | Meaning |
|---|---|
| `clientId`, `clientSecret` | the confidential client registered at the IdP |
| `discoveryUrl` | `.../.well-known/openid-configuration`. Or give the endpoints yourself: |
| `authorizationUrl`, `tokenUrl`, `userInfoUrl`, `issuer` | explicit endpoints (needs at least `authorizationUrl` + `tokenUrl` when there is no `discoveryUrl`) |
| `scopes` | default `["openid","profile","email"]`. Add what the IdP needs before it releases roles or groups (for Authentik/Keycloak often `groups` or a custom scope) |
| `pkce` | default `true`; set `false` only if the IdP rejects the extra parameters |
| `prompt` | optional: `login`, `select_account` or `consent`, sent on every sign-in. **`login` forces the IdP to ask for credentials every time**, which is what a shared workstation needs (section 5) |
| `maxAge` | optional, seconds (0 to 86400): the IdP must re-authenticate a person whose own session is older (`max_age`); `0` is the same as always |
| `claims` | which claim holds what, see 3.2 |
| `rolesClaim`, `groupsClaim` | see 3.3 |

All URLs (`discoveryUrl`, `issuer`, `authorizationUrl`, `tokenUrl`, `userInfoUrl`) must be https. In `ACCESS_SOURCE=claims` the provider also needs a `discoveryUrl` or an `issuer` (the id token's `iss` is compared with it) and **may not use a multi-tenant authority** (a URL with `/common/`, `/organizations/` or `/consumers/` in it): such a provider is skipped with a warning.

**`entra`** (Microsoft Entra ID through the built-in provider, always id `microsoft`): `clientId`, `clientSecret`, `tenantId` (**required: your single tenant id, a GUID**; `common`, `organizations`, `consumers` and names are refused and the provider is skipped), `scopes` (optional extra scopes; `offline_access` is never requested), `prompt` (as above), `rolesClaim`, `groupsClaim`. Roles and groups are read from the id token Entra issues. The app asks for `openid profile email` only (no Graph, no refresh token) and refuses an id token whose audience, issuer or `tid` is not yours.

**`saml`** (SAML 2.0, HTTP-Redirect AuthnRequest, HTTP-POST response)

| Field | Meaning |
|---|---|
| `idpMetadataFile` (preferred) or `idpMetadataXml` | the IdP's metadata XML (entity id, SSO endpoint and signing certificate in one). A file that cannot be read skips the provider. |
| or `entryPoint` + `idpEntityId` + `cert` | the SSO URL, the IdP's entity id and its PEM signing certificate |
| `spEntityId` | this app's entity id; default is the SP metadata URL (section 6) |
| `cert` | a PEM string, **or a list of them during a certificate rollover** (a response signed by any of them verifies) |
| `wantAssertionsSigned` | cosmetic, leave it out. Unsigned responses are **always** refused whatever it says; `false` only logs a warning. |
| `allowIdpInitiated` | default **`false`**: every login must start here and the response must carry a signed InResponseTo that answers a request this app issued. `true` also accepts a response that answers no request of ours (a login started from the IdP's portal); it cannot be tied to the browser that started it (login CSRF), so prefer to keep the IdP's portal link pointing at this app's sign-in page. |
| `allowDeprecatedAlgorithms` | default `false`: responses signed with SHA-1 (or digests with SHA-1) are refused. The escape is installation-wide for the plugin's own (SP-side) checks and warns at start; use it only until the IdP is fixed. |
| `authnRequestsSigned` + `signingPrivateKey` | sign the AuthnRequest with this PEM key (if the IdP demands it) |
| `signatureAlgorithm`, `digestAlgorithm`, `identifierFormat`, `audience` | passed to the SAML library when the IdP needs a specific value |
| `claims`, `rolesClaim`, `groupsClaim` | attribute names, see 3.2 and 3.3 |

### 3.2 `claims`: where the identity is

| Key | Default | Meaning |
|---|---|---|
| `email` | `email`, then `mail`, `upn`, `preferred_username` (OIDC); SAML needs it set (else the NameID is used, which is rarely an address) | the e-mail address; only a value that looks like an address is accepted |
| `name` | `name`, then `given_name` + `family_name`, `preferred_username`, the address (OIDC); `displayName` (SAML) | display name |
| `userId` | `sub` (OIDC); NameID (SAML) | the stable identifier of the person at this IdP; it becomes the account id. **Changing it later detaches everybody from their account**, so settle it before go-live. For OIDC it may **not** be `email`, `mail`, `upn`, `preferred_username`, `name` or `email_verified` (an administrator can re-assign those to another person, who would then become the first person's account): such a provider is skipped. For SAML the same rule is only warned about when `userId` equals `email`, because the NameID is often the only stable value available: pick an immutable one (an employee number, an object GUID). |
| `emailVerified` | the standard `email_verified` claim (OIDC); never asserted for SAML (the plugin's trust option is off) | claim that says the address is verified (`true` or the string `"true"`). Only used to decide whether a login may be linked to an *existing* account with the same address (section 5). Never true for an address taken from a fallback claim. |
| `firstName`, `lastName` | SAML `givenName`, `surname` | SAML only |
| `upn`, `preferredUsername` | | SAML only: copied into the stored identity snapshot (OIDC tokens already carry them) |

A dotted name (`realm_access.roles`) reads a nested object when no claim has exactly that name; SAML attribute names that are URLs (`http://schemas.../role`) are matched as they are.

### 3.3 `rolesClaim` and `groupsClaim`

Either a claim name (`"roles"`: the value is a JSON array, or a single string that counts as one value), or an object:

```json
"groupsClaim": { "name": "memberOf", "format": "delimited", "separator": ";" }
```

`format: "array"` is the default; `"delimited"` splits one string on `separator` (default `,`). An absent claim means "no values". A claim of the wrong shape (an object, a number, an array where a string is declared, an array holding non-strings) is **invalid**, and an invalid claim makes the whole login grant nothing (section 4). SAML multi-valued attributes arrive as arrays, single-valued ones as a plain string; both work with `format: "array"`.

If neither is configured for a provider, that provider's logins carry no roles and store nothing.

### 3.4 `roles`

One provider (the usual case):

```json
"roles": {
  "appRoleMap":   { "<value of rolesClaim>":  "tt-administrator" },
  "groupRoleMap": { "<value of groupsClaim>": { "role": "tt-logleser" } }
}
```

Several providers: **each provider has its own maps**, because one IdP's role names must not mean something at another (a group called `admin` at a municipality's guest IdP is not the administrators of the main one):

```json
"roles": {
  "byProvider": {
    "kommune": { "appRoleMap": { "referat-administrator": "tt-administrator", "referat-bruger": "tt-bruger" } },
    "os2faktor": { "appRoleMap": { "Administrator": "tt-administrator" }, "groupRoleMap": { "G-Borger": "tt-bruger" } }
  }
}
```

The top-level `appRoleMap` / `groupRoleMap` are only a shorthand for **one** provider: with exactly one provider in the file they apply to it; with several, a provider that has no `byProvider` entry **grants nothing** (and a start-up warning says so). A provider with a `byProvider` entry uses only that entry. A `byProvider` key must be a provider id; a key that names no configured provider is unused (warned).

The values are one of the four role keys (`tt-bruger`, `tt-skabelonansvarlig`, `tt-logleser`, `tt-administrator`); the keys are matched exactly (case-sensitive) against the claim values. Unknown claim values are ignored. A role granted from a claim is always **global**, because a claim carries no org unit; the object form `{ "role": "...", "global": false }` exists only to switch an entry off without deleting it. `tt-skabelonansvarlig` as a global role is the **superuser** who manages every shared prompt; `access.manage`, `sync.run` and `audit.export` need a global role, which a claim always is, so `tt-administrator` and `tt-logleser` from a claim have them.

**Ordinary users must be mapped too.** In claims mode "no role, no access" is the default (section 4): a person who signs in at the IdP but is mapped to no role is refused. Map your ordinary users' value (an app role, or a group everybody has) to `tt-bruger`.

### 3.5 `catalogue`

```json
"catalogue": [
  { "kind": "role",  "identifier": "referat-administrator", "name": "Administrator" },
  { "kind": "group", "identifier": "G-Borgerservice",       "name": "Borgerservice" }
]
```

```json
{ "kind": "role", "identifier": "Administrator", "name": "Administrator", "providers": ["os2faktor"] }
```

`providers` is optional: without it an entry matches the value whichever provider it comes through; with it, a login through **another** provider that happens to carry the same value stores nothing, so provider B's values never match a prompt meant for provider A's people. (The stored values stay one global list; the filter is applied when a login is written.)

The role/group **catalogue**: the only values the app will remember for a person, and the list a superuser picks from when targeting a shared prompt at roles or groups (`templates.md`). It is loaded into `public.external_roles` at start (source `config`, retried with a growing delay if the database is not up yet); an entry that leaves the file is deactivated, never deleted. **A catalogue that is unreadable or invalid, or an explicitly empty `"catalogue": []`, never deactivates anything**: only removing the whole section does. The catalogue can also be filled from OS2rollekatalog's read API (source `rollekatalog`, optional, refreshed by a cron route or the admin button; `rollekatalog.md` section 12); both sources live side by side in the same table and the targeting UI shows them merged. Without any catalogue nothing is stored for any person. The identifiers must equal the **values the IdP puts in the claims**, or a person never matches a prompt targeted at them. This is deliberate: **the app keeps no role or group name it was not told to keep.**

### 3.6 Failure behaviour

| What is wrong | What happens |
|---|---|
| The file is missing, unreadable or not a JSON object | no providers from it (and the legacy variables stay ignored); `roles` unusable, nobody gets a role from claims; one warning |
| A provider entry is invalid, references an unset `${VAR}`, repeats an id, or (SAML) its metadata file is unreadable | that provider is skipped, the others work; a warning names the entry number and the field path, never a value |
| A provider breaks a security rule: a non-https IdP URL, Entra without a tenant GUID, a multi-tenant authority in claims mode, a mutable `claims.userId`, a reserved id, no https `BETTER_AUTH_URL` in production | that provider is skipped with a warning naming the rule |
| `roles` is invalid, references an unset `${VAR}`, or the file has an unknown top-level key | **fail closed**: nobody gets a role from claims until it is fixed (providers still work) |
| `catalogue` is invalid | ignored: nothing new is stored for anybody, and what is already in the database is **left alone** (not deactivated) |

## 4. How roles reach the app (ACCESS_SOURCE=claims)

At **every login** (OIDC, Entra and SAML alike), in one database transaction:

1. The person's directory row is found, or created on the first login with source `claims`. A disabled person gets nothing.
2. Their previous claims-sourced role rows are **deleted and replaced** by the roles the claims say now. A role that left the claims is gone; nothing accumulates.
3. Their stored role/group values are replaced too, but only values that are in the catalogue are kept.

Fail closed: no claims, a malformed claim, an unusable `roles` section, an unknown provider, a disabled person, or a database error leave **nothing**. A password sign-in clears the person's claims rows: a session that did not come from the IdP inherits no roles.

Roles are read **live** at every request (`resolvePrincipal`); nothing role-related is in the session cookie. A claims row counts only while it is younger than `ROLE_CLAIMS_MAX_SECONDS` (default 28800 = 8 hours). **In claims mode the session lasts exactly that long and is never extended**, so a session cannot outlive the roles it was granted on, and the next sign-in (usually silent single sign-on) refreshes them.

What this means for offboarding: a role removed in the IdP is removed here at the person's next login, and at the latest when their session ends. The IdP is only asked at login. If that is too slow, lower `ROLE_CLAIMS_MAX_SECONDS` (60 at the shortest); the price is more frequent re-login. Disabling the *person* in the IdP also stops new logins at once.

**Claims mode is closed by default.** `REQUIRE_ROLE_TO_LOGIN` is **true** unless it is explicitly `false`: a person who signs in at the IdP but is mapped to no role gets the "Ingen adgang" page and a 403 on every API call, so ordinary users must be mapped to `tt-bruger` (section 3.4). E-mail/password sign-in is **off** unless `EMAIL_PASSWORD_ENABLED` is explicitly `true`, and even then **sign-up stays disabled** (a password account holds no role anyway, and anyone able to type an address would otherwise get an account). Do not set either variable to its permissive value unless you mean it: both log a start-up warning. In docker compose leave them blank; "unset" must stay detectable.

**Break-glass.** There is no administrator in the app to lock out, and no bootstrap or last-administrator rule in this mode. Keep an administrator path on the IdP side (a named, controlled account that carries the administrator claim) and document who may use it.

**The admin pages** (Brugere og roller, Organisation) are read-only: "Brugere og roller" shows who holds which role as of their last login and explains where roles are assigned. The in-app grant/revoke endpoints, the org-unit and member endpoints and the first-administrator bootstrap answer 409 / do nothing (kill switch `ACCESS_LOCAL_ADMIN`; it is always off outside local mode). `ACCESS_SOURCE=local` and the local admin stay available for development and demos.

## 5. OIDC

- **Redirect URI** to register: `<BETTER_AUTH_URL>/api/auth/oauth2/callback/<id>`.
- **User info.** Only the id token is read when it already carries `sub` and an address and every configured role/group claim. Otherwise the app also asks the userinfo endpoint (from `userInfoUrl` or the discovery document) and merges what is missing; the id token wins on a clash and a userinfo answer for a *different* `sub` is discarded. If the endpoint fails the missing claims are simply absent, which grants nothing.
- **Account linking.** Same rule as before: an SSO login links into an existing account with the same address only when both sides are verified; password accounts are never linked. Do not mark providers "trusted".
- **What is checked on the id token.** Before any claim is read: `aud` contains the client id, `iss` equals the configured `issuer` or the discovery document's `issuer`, and the token has not expired (a minute of tolerance). If the issuer cannot be determined (the discovery document is unreachable) the login is refused. A mismatch refuses the login: no user, no session.
- **Tokens are not kept.** The access, refresh and id tokens better-auth stores in `accounts` are set to NULL as soon as the login hooks have read them, and the app never asks for `offline_access` itself (do not add it to `scopes`: a refresh token would be discarded anyway). The identity snapshot (`external_identities`) holds only the whitelisted identity claims, never role or group values.
- **Sessions on shared PCs.** RP-initiated logout (`end_session_endpoint`) and back-channel logout are **not built**: signing out of the app does not sign the person out of the IdP, and with silent single sign-on the next click on the provider button signs the next person at that PC straight in as the previous one. For shared workstations set `"prompt": "login"` on the provider (the IdP then asks for credentials every time), optionally with `"maxAge": 0`, or have the IdP end its own session by other means. In claims mode the session is never extended by activity (it lasts `ROLE_CLAIMS_MAX_SECONDS` from the login, no sliding refresh). Ask the client whether this matters (question 7 of the plan).
- **Entra ID.** Roles appear in the id token only if the app registration defines **App roles** and assigns them to users or groups (claim `roles`, an array). A `groups` claim has to be switched on under Token configuration, carries object ids, and is **not sent when the person is in too many groups** (about 200 for a JWT; "group overage", the token then has only a pointer to Microsoft Graph). The app does **not** call Graph: use app roles, or keep users in fewer groups. `tenantId` is mandatory and must be your tenant's GUID: app role values and group GUIDs are only unique inside one tenant, so a multi-tenant app would let a foreign tenant mint a role named like yours. **The account id is Entra's `sub`, which is pairwise per application registration**: registering the application again (a new client id) gives every person a new `sub`, hence a new, empty account. Keep the registration, or plan a migration.

## 6. SAML

URLs of the installation (substitute `BASE` = `BETTER_AUTH_URL` and `ID` = the provider `id`):

| What | URL |
|---|---|
| Assertion Consumer Service (HTTP-POST) | `BASE/api/auth/sso/saml2/sp/acs/ID` |
| SP metadata (give this URL or file to the IdP) | `BASE/api/auth/sso/saml2/sp/metadata?providerId=ID` |
| SP entity id | the metadata URL, unless `spEntityId` is set |

`BETTER_AUTH_URL` must be the public https URL; a SAML provider is skipped (with a warning) when it is not set and there is no `spEntityId`.

**What is checked on a response.** The signature (of the response or of the assertion) with the IdP certificate from the metadata or the `cert` field(s); the signature and digest **algorithms** (SHA-256 and up; SHA-1 only with `allowDeprecatedAlgorithms`); the issuer; the time window (`NotBefore` / `NotOnOrAfter`, required); that there is exactly one assertion; that the assertion id was not used before (replay). An **unsigned response is always refused**; `wantAssertionsSigned` does not switch that off. Besides, `saml-guard.ts` makes the checks the better-auth sso plugin (1.6.11) does not: a body with a `DOCTYPE` or `ENTITY` declaration is refused before any XML parser sees it; the signed **Audience** must be this app's entity id; the signed **Recipient** is **required** and must be this app's ACS URL, and a response signed as a whole must carry a **Destination** equal to it; and unless `allowIdpInitiated`, the signed assertion's **InResponseTo** (not the unsigned-capable Response-level one) must answer an AuthnRequest this app issued for this provider and not yet consumed. The ACS URL and the entity id come from `BETTER_AUTH_URL`, never from the request's Host header. Without these a response the IdP signed for *another* service provider would be accepted here.

**Clocks.** The library checks `NotBefore` / `NotOnOrAfter` with **no tolerance** (the plugin's 5 minute allowance is applied after the library has already refused). A host whose clock is a few seconds behind the IdP refuses logins whose `NotBefore` is "in the future": keep the host and the IdP on NTP.

**Attributes.** `claims` maps the standard ones; `rolesClaim` / `groupsClaim` name the attributes that carry roles and groups. They reach the same code as OIDC claims. An attribute that is not mapped is not read.

**Not supported:** encrypted assertions, SAML single logout, HTTP-POST binding for the AuthnRequest, and signing keys that rotate without a metadata update (use `idpMetadataFile` and restart when the IdP rolls its certificate; with `entryPoint` + `cert`, list the old and the new certificate in `cert` during the rollover). IdP metadata whose endpoints are not https (a `Location` attribute) makes the provider be skipped. Provider management through the plugin's database table and its REST endpoints is disabled on purpose; the file is the only way to add a provider.

**Dependencies.** SAML runs on `@better-auth/sso` 1.6.11 and `samlify`. `package.json` pins `samlify` to 2.13.1 with an `overrides` entry: the version the plugin brings (2.10.2) is affected by advisories on XML injection in attribute values (GHSA-34r5-q4jw-r36m) and on `node-forge` signature verification (GHSA-86w9-cpqp-85rv). The plugin, `better-auth` and `@better-auth/core` are exact-pinned too (the saml guard relies on the plugin's internals): **any upgrade of any of them must re-run `src/lib/auth/saml.flow.test.ts` and `oidc.flow.test.ts`**, which logs in through the real plugin with signed, unsigned, wrongly signed, tampered, replayed, expired and foreign-audience responses.

## 7. Recipes

All of these are **starting points**. Where a name is marked *ask*, the municipality (or the IdP's operator) has to tell you the real one; the quickest way to find out is to log in once and decode the id token (OIDC) or read the SAML response in the browser's network tab.

### Entra ID (OIDC)

```json
{ "type": "entra", "label": "Microsoft", "clientId": "<application id>", "clientSecret": "${ENTRA_SECRET}",
  "tenantId": "<your tenant id, a GUID>", "rolesClaim": "roles" }
```

Define app roles in the app registration (value e.g. `referat-administrator`), assign them under Enterprise applications → Users and groups, and map those values in `appRoleMap`. E-mail and name come from the usual claims; if `email` is missing, add it as an optional claim. Register the redirect URI of the *built-in* provider: `BASE/api/auth/callback/microsoft`.

### Entra ID (SAML)

Claim URIs Microsoft uses by default (check them in the enterprise application's Attributes & Claims):

```json
{ "type": "saml", "id": "entra", "label": "Microsoft", "idpMetadataFile": "/config/entra-metadata.xml",
  "claims": { "email": "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
              "name": "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
              "userId": "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name" },
  "rolesClaim": "http://schemas.microsoft.com/ws/2008/06/identity/claims/role" }
```

(Which attribute is the stable person identifier is a choice for the municipality: *ask*.)

### Authentik (for example Hjørring)

OIDC. Discovery URL `https://<host>/application/o/<application slug>/.well-known/openid-configuration`. Authentik can put a person's groups in a claim (the default `profile` scope mapping includes `groups`; verify in the token), or you add a custom property mapping that emits roles. *Ask* which claim carries the role and whether it is groups or a custom claim.

```json
{ "type": "oidc", "id": "authentik", "label": "Hjørring login",
  "clientId": "...", "clientSecret": "${AUTHENTIK_SECRET}",
  "discoveryUrl": "https://<host>/application/o/<slug>/.well-known/openid-configuration",
  "scopes": ["openid", "profile", "email"],
  "groupsClaim": "groups" }
```

with `"roles": { "groupRoleMap": { "<authentik group name>": "tt-bruger" } }`. If the installation already used the `AUTHENTIK_*` variables, keep `"id": "authentik"` so the registered redirect URI and the existing accounts keep working.

### FKA (Fælleskommunal Adgangsstyring)

*Ask the municipality / KOMBIT* which protocol (OIDC or SAML) FKA offers for this solution, the endpoints or metadata, and the exact names of the user id, e-mail, name and role attributes. Do not assume that FKA uses the same claim names as another IdP. When you know them, the file is one of the generic entries above. The point of this installation model is that those names live in the file of that one municipality, so they never have to be agreed once for everyone.

### OS2faktor

*Ask* the municipality: OS2faktor can act as an IdP over SAML 2.0 (and OIDC, depending on the setup); the attributes it releases to a service provider are configured per service provider in OS2faktor, so the names are theirs to state. Use `idpMetadataFile` with the metadata they export, and map `claims`, `rolesClaim`, `groupsClaim` to the attribute names they give you. If OS2rollekatalog feeds OS2faktor, the roles arrive as attributes with the values defined there; use those values as the keys of `appRoleMap`.

### Keycloak

OIDC with a discovery URL `https://<host>/realms/<realm>/.well-known/openid-configuration`. Realm roles are nested: with a mapper that adds roles to the token they are typically at `realm_access.roles`, client roles at `resource_access.<client>.roles` (verify in a decoded token); use that dotted name as `rolesClaim`. For SAML, add a role-list mapper to the client and use the attribute name you gave it.

## 8. Checking and troubleshooting

1. **Start the app** and read the log. `[auth] Ignoring providers[1]: invalid (clientSecret:too_small)` names the entry and the field, never a value. `[auth] ACCESS_SOURCE=claims but the config file has no "roles" section` says nobody can get a role.
2. **Log in** with a test person who should be an administrator. Open Administration → Brugere og roller: they must be listed with the role and the source "Identitetsudbyder".
3. **No role after login?** In this order: is the claim in the token at all (decode it)? Is the claim name in `rolesClaim` exactly that (case matters; SAML names are often URLs)? Is the value a key of `appRoleMap` exactly (case matters)? Does the IdP release the claim only for a scope you did not list (`scopes`)? Is the claim a different *shape* than `format` says (a string where you declared an array of strings is fine, an object is not)? Is `ACCESS_SOURCE=claims` and `AUTH_CONFIG_FILE` set (the legacy variables never carry role claims)?
4. **Everybody lost their role after a while.** `ROLE_CLAIMS_MAX_SECONDS` passed and the session ended; people sign in again.
5. **"account not linked"** after a login: a password account with the same address exists. Remove it or have the person use the way they registered.
6. **SAML refused** (`/api/auth/error?error=invalid_saml_response`): the audit log has an `auth.login_failed` with method `saml`. Usual causes: the IdP signs with a different certificate than the metadata the app read (restart after replacing it), a clock that is even a few seconds behind the IdP (the library keeps no tolerance: use NTP), an unsigned or SHA-1 signed response, a response without Recipient, an IdP-initiated response while `allowIdpInitiated` is false, the IdP's Audience is not the SP entity id, the ACS URL registered at the IdP differs from the app's (check `BETTER_AUTH_URL` and the scheme).
7. **Audit.** Logins and failed logins are recorded with the method (`oidc`, `microsoft`, `saml`, `password`) and the provider id only. No claim value, role, group, name or assertion is ever written to the audit log or to the app log.

## 9. Docker details

`docker-compose.yml` mounts `AUTH_CONFIG_DIR` (default `./auth-config`) read-only at `/config` and forwards `AUTH_CONFIG_FILE`, `ACCESS_LOCAL_ADMIN` and `ROLE_CLAIMS_MAX_SECONDS`. A `${NAME}` in the file is read from the **container's** environment, so each such variable has to be forwarded, in a `docker-compose.override.yml`:

```yaml
services:
  app:
    environment:
      - KOMMUNE_CLIENT_SECRET=${KOMMUNE_CLIENT_SECRET}
```

or the secret is written into the file itself (then keep the file readable only by the account that runs Docker). SAML metadata XML files go in the same directory and are referenced as `/config/<file>.xml`.

## 10. Local testing

`docs/central-access/dev-simulation.md` ("Claims mode") starts a simulated OIDC and a simulated SAML IdP that emit roles and groups, runs the app with a ready-made config file and checks 40 behaviours end to end. For a real SAML IdP on a laptop use Keycloak (`docker run -p 8081:8080 -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin quay.io/keycloak/keycloak start-dev`): create a realm, a client of type SAML with the ACS URL and entity id from section 6 (sign assertions on, client signature off), download the realm's SAML IdP descriptor to `auth-config/keycloak-metadata.xml` and reference it as `idpMetadataFile`.
