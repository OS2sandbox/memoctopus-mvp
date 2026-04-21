# Authentik SSO setup

Memoctopus supports [Authentik](https://goauthentik.io) as an optional OIDC identity provider. When configured, a "Continue with Authentik" button appears on the sign-in page alongside email/password (and Microsoft, if also configured).

The integration is opt-in per deployment: if the environment variables below are not set, nothing changes.

## What you need

- A running Authentik instance reachable from the browsers that will log in
- Admin access to that Authentik instance
- The public URL of your Memoctopus deployment (what users type into the browser) — below referred to as `<BETTER_AUTH_URL>`

## Authentik side

### 1. Create an OAuth2 / OpenID provider

In the Authentik admin UI:

1. **Providers → Create → OAuth2/OpenID Provider**
2. Name it (e.g. `memoctopus`)
3. **Client type:** Confidential
4. **Client ID / Client Secret:** leave the generated values — you will copy them later
5. **Redirect URIs / Origins (RFC 6749):**
   ```
   <BETTER_AUTH_URL>/api/auth/oauth2/callback/authentik
   ```
   Example for a local dev instance:
   ```
   http://localhost:3000/api/auth/oauth2/callback/authentik
   ```
   Use **Strict** matching mode. If you choose **Regex**, escape the dots.
6. **Signing Key:** pick (or create) an RSA key. Authentik needs this to sign ID tokens.
7. Leave the default scopes (`openid`, `profile`, `email`) — Memoctopus requests exactly these.
8. Save.

### 2. Create an application

1. **Applications → Applications → Create**
2. Name it (e.g. `Memoctopus`)
3. **Slug:** choose a URL-safe slug, e.g. `memoctopus`. The slug becomes part of the discovery URL.
4. **Provider:** select the provider you just created.
5. Save.

### 3. Assign users / groups

Bind the users (or groups) who should be allowed to sign in to the application via **Applications → Applications → *your app* → Policy / Group / User Bindings**. Without a binding, the default Authentik policy applies.

### 4. Copy the three values

You will need these for your `.env`:

- **Client ID** — from the provider page
- **Client Secret** — from the provider page
- **Discovery URL** — formed from your Authentik host and the application slug:
  ```
  https://<your-authentik-host>/application/o/<your-app-slug>/.well-known/openid-configuration
  ```
  Example:
  ```
  https://auth.example.org/application/o/memoctopus/.well-known/openid-configuration
  ```
  Visit this URL in a browser — you should see a JSON document with `authorization_endpoint`, `token_endpoint`, etc. If you get a 404, double-check the slug.

## Memoctopus side

Add the following to your `.env` (see `.env.example` for the full template):

```env
AUTHENTIK_CLIENT_ID=<the client id from step 4>
AUTHENTIK_CLIENT_SECRET=<the client secret from step 4>
AUTHENTIK_DISCOVERY_URL=<the discovery URL from step 4>

# Show the "Continue with Authentik" button on the sign-in page
NEXT_PUBLIC_AUTHENTIK_ENABLED=true
```

Restart the frontend container so it picks up the new variables:

```bash
docker compose up -d --build frontend
```

## Verification

1. Open `<BETTER_AUTH_URL>/sign-in` in a fresh browser (or incognito).
2. Confirm the **Continue with Authentik** button is visible under "Or continue with".
3. Click it — you should be redirected to your Authentik login page.
4. After signing in, you should land on `/app`.

### Troubleshooting

- **Button not visible** — `NEXT_PUBLIC_AUTHENTIK_ENABLED` must be exactly `true` (lowercase). Rebuild the frontend image; `NEXT_PUBLIC_*` values are baked in at build time.
- **`redirect_uri_mismatch` from Authentik** — the redirect URI in the Authentik provider must match `<BETTER_AUTH_URL>/api/auth/oauth2/callback/authentik` byte-for-byte. Watch out for trailing slashes and http vs https.
- **`invalid_client`** — Client ID or Client Secret is wrong, or the Authentik application is not bound to the provider.
- **JWKS / signature errors at userinfo** — the Authentik provider has no signing key assigned. Go back and pick an RSA key.
- **404 on the discovery URL** — the application slug in the URL does not match the Authentik application slug.

## Account linking

When an Authentik user signs in with an email that already exists in Memoctopus (e.g. they previously registered via email/password), the accounts are linked automatically. There is no duplicate user — the existing user gains a second login method. This is safe because Authentik reports verified emails.

If you do not want Authentik users to be able to link onto pre-existing password accounts, do not enable Authentik on that deployment.

## Security notes

- The integration uses **PKCE** and **state**, both mandatory.
- **Do not** commit your real `AUTHENTIK_*` values to the shared repository. Each deployment defines its own in its private `.env`.
- The server side only registers the Authentik provider when all three of `AUTHENTIK_CLIENT_ID`, `AUTHENTIK_CLIENT_SECRET`, `AUTHENTIK_DISCOVERY_URL` are present. The `NEXT_PUBLIC_AUTHENTIK_ENABLED` flag is purely for UX — it toggles the button visibility and cannot itself grant access.
