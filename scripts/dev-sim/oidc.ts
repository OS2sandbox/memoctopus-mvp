// A tiny OpenID Connect provider with a "pick a person" login page, so the app can be
// logged into as any simulated Rollekatalog user without a real IdP. Authorization-code
// flow, RS256 id tokens, PKCE (S256) and userinfo: just what better-auth's genericOAuth
// needs. TEST ONLY: anyone who can reach this port can log in as anyone.
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import http from 'node:http';
import { escHtml, idpUrl, SIM } from './config';

export interface Persona {
  /** Value of the preferred_username claim, the key the app matches on. */
  username: string;
  name: string;
  email: string;
  emailVerified: boolean;
  /** One line shown on the login page. */
  note?: string;
  /**
   * Extra claims put into the id token and userinfo, e.g. `{ roles: ['referat-admin'], memberOf: 'G-A;G-B' }`
   * (what ACCESS_SOURCE=claims reads). Can be replaced at runtime with MockIdp.setClaims.
   */
  claims?: Record<string, unknown>;
}

interface PendingCode {
  persona: Persona;
  redirectUri: string;
  nonce?: string;
  challenge?: string;
  expires: number;
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export interface MockIdp {
  close(): Promise<void>;
  /** Replaces the extra claims of one person from now on (null: back to the persona's own). */
  setClaims(username: string, claims: Record<string, unknown> | null): void;
  /** Number of completed logins, for the acceptance script. */
  logins: Array<{ username: string }>;
}

export async function startMockIdp(getPersonas: () => Persona[]): Promise<MockIdp> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'sim-key-1';
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };

  const codes = new Map<string, PendingCode>();
  const tokens = new Map<string, Persona>();
  const logins: Array<{ username: string }> = [];
  const claimOverrides = new Map<string, Record<string, unknown>>();

  const sub = (p: Persona) => createHash('sha256').update(`sim-sub:${p.username}`).digest('hex').slice(0, 32);

  function claimsOf(p: Persona) {
    return {
      ...(claimOverrides.get(p.username) ?? p.claims ?? {}),
      sub: sub(p),
      name: p.name,
      email: p.email,
      email_verified: p.emailVerified,
      preferred_username: p.username,
    };
  }

  function idToken(p: Persona, aud: string, nonce?: string): string {
    const now = Math.floor(Date.now() / 1000);
    const header = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
    const payload = b64u(
      JSON.stringify({ iss: idpUrl, aud, iat: now, exp: now + 600, ...(nonce ? { nonce } : {}), ...claimsOf(p) }),
    );
    const sig = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey);
    return `${header}.${payload}.${b64u(sig)}`;
  }

  const readBody = (req: http.IncomingMessage) =>
    new Promise<string>((resolve) => {
      let s = '';
      req.on('data', (c) => (s += c));
      req.on('end', () => resolve(s));
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', idpUrl);
    const send = (status: number, body: unknown, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    if (url.pathname === '/.well-known/openid-configuration') {
      return send(200, {
        issuer: idpUrl,
        authorization_endpoint: `${idpUrl}/authorize`,
        token_endpoint: `${idpUrl}/token`,
        userinfo_endpoint: `${idpUrl}/userinfo`,
        jwks_uri: `${idpUrl}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        scopes_supported: ['openid', 'profile', 'email'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        code_challenge_methods_supported: ['S256'],
        claims_supported: ['sub', 'name', 'email', 'email_verified', 'preferred_username', 'roles', 'memberOf'],
      });
    }
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      return void res.end();
    }
    if (url.pathname === '/jwks') return send(200, { keys: [jwk] });

    // Step 1: show the persona picker (or skip it with ?login_hint=<username>, used by the acceptance script).
    if (url.pathname === '/authorize' && req.method === 'GET') {
      const q = url.searchParams;
      if (q.get('client_id') !== SIM.oidc.clientId) return send(400, { error: 'invalid_client' });
      const redirectUri = q.get('redirect_uri') ?? '';
      if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(redirectUri)) return send(400, { error: 'invalid_redirect_uri' });
      const personas = getPersonas();
      const hint = q.get('login_hint');
      const chosen = hint ? personas.find((p) => p.username === hint) : undefined;
      if (hint && !chosen) return send(400, { error: 'unknown_persona' });
      const params = Object.fromEntries(q.entries());
      if (chosen) return finishLogin(res, chosen, params);

      const rows = personas
        .map(
          (p) => `<li><form method="post" action="/authorize">
            ${Object.entries(params).map(([k, v]) => `<input type="hidden" name="${escHtml(k)}" value="${escHtml(v)}">`).join('')}
            <button name="persona" value="${escHtml(p.username)}"><b>${escHtml(p.name)}</b> <code>${escHtml(p.username)}</code></button>
            <small>${escHtml(p.email)}${p.emailVerified ? '' : ' (e-mail ikke verificeret)'}${p.note ? ' · ' + escHtml(p.note) : ''}</small>
          </form></li>`,
        )
        .join('');
      return send(
        200,
        `<!doctype html><meta charset="utf-8"><title>Simuleret login</title>
        <style>body{font:16px system-ui;max-width:42rem;margin:2rem auto;padding:0 1rem}li{list-style:none;margin:.4rem 0}
        button{padding:.4rem .8rem;margin-right:.6rem;cursor:pointer}small{color:#555}</style>
        <h1>Simuleret kommune-login</h1><p>Test-IdP. Vælg hvem du vil logge ind som.</p><ul>${rows}</ul>`,
        'text/html; charset=utf-8',
      );
    }
    if (url.pathname === '/authorize' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      const chosen = getPersonas().find((p) => p.username === form.get('persona'));
      if (!chosen) return send(400, { error: 'unknown_persona' });
      return finishLogin(res, chosen, Object.fromEntries(form.entries()));
    }

    // Step 2: the app exchanges the code.
    if (url.pathname === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      let clientId = form.get('client_id');
      let secret = form.get('client_secret');
      const basic = req.headers.authorization?.match(/^Basic (.+)$/i);
      if (basic) {
        const [id, ...rest] = Buffer.from(basic[1], 'base64').toString().split(':');
        clientId = decodeURIComponent(id);
        secret = decodeURIComponent(rest.join(':'));
      }
      if (clientId !== SIM.oidc.clientId || secret !== SIM.oidc.clientSecret) return send(401, { error: 'invalid_client' });
      if (form.get('grant_type') !== 'authorization_code') return send(400, { error: 'unsupported_grant_type' });
      const code = form.get('code') ?? '';
      const pending = codes.get(code);
      codes.delete(code); // one use
      if (!pending || pending.expires < Date.now()) return send(400, { error: 'invalid_grant' });
      if (form.get('redirect_uri') !== pending.redirectUri) return send(400, { error: 'invalid_grant' });
      if (pending.challenge) {
        const verifier = form.get('code_verifier') ?? '';
        const expected = createHash('sha256').update(verifier).digest('base64url');
        if (expected !== pending.challenge) return send(400, { error: 'invalid_grant', error_description: 'pkce' });
      }
      const accessToken = randomBytes(24).toString('hex');
      tokens.set(accessToken, pending.persona);
      logins.push({ username: pending.persona.username });
      return send(200, {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 600,
        scope: 'openid profile email',
        id_token: idToken(pending.persona, SIM.oidc.clientId, pending.nonce),
      });
    }

    if (url.pathname === '/userinfo') {
      const m = req.headers.authorization?.match(/^Bearer (.+)$/i);
      const persona = m ? tokens.get(m[1]) : undefined;
      if (!persona) return send(401, { error: 'invalid_token' });
      return send(200, claimsOf(persona));
    }

    send(404, { error: 'not_found' });
  });

  function finishLogin(res: http.ServerResponse, persona: Persona, params: Record<string, string>) {
    const code = randomBytes(16).toString('hex');
    codes.set(code, {
      persona,
      redirectUri: params.redirect_uri,
      nonce: params.nonce,
      challenge: params.code_challenge_method === 'S256' ? params.code_challenge : undefined,
      expires: Date.now() + 60_000,
    });
    const target = new URL(params.redirect_uri);
    target.searchParams.set('code', code);
    if (params.state) target.searchParams.set('state', params.state);
    target.searchParams.set('iss', idpUrl);
    res.writeHead(302, { Location: target.toString() });
    res.end();
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(SIM.idpPort, '127.0.0.1', resolve);
  });

  return {
    logins,
    setClaims: (username, claims) => {
      if (claims) claimOverrides.set(username, claims);
      else claimOverrides.delete(username);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
