// A tiny SAML 2.0 identity provider with the same "pick a person" page as the OIDC stand-in, so
// the app's SAML login can be tried and acceptance-tested without Keycloak. It signs assertions
// with a throwaway key made at start-up (needs `openssl`) and publishes its metadata at
// /metadata AND to a file (SIM.saml.metadataFile) that the app's auth config points at
// (`idpMetadataFile`), so the sim must be running before the app starts.
// TEST ONLY: anyone who can reach this port can log in as anyone.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import * as saml from 'samlify';
import { buildSamlResponse, generateIdpKeys, parseAuthnRequestUrl } from '../../src/test/saml-idp';
import { samlUrl, SIM } from './config';
import type { Persona } from './oidc';

export interface MockSamlIdp {
  close(): Promise<void>;
  setClaims(username: string, claims: Record<string, unknown> | null): void;
  logins: Array<{ username: string }>;
}

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function startMockSamlIdp(getPersonas: () => Persona[]): Promise<MockSamlIdp> {
  const keys = generateIdpKeys('dev-sim-saml-idp');
  const entityId = `${samlUrl}/metadata`;
  const ssoUrl = `${samlUrl}/sso`;
  const logins: Array<{ username: string }> = [];
  const overrides = new Map<string, Record<string, unknown>>();

  const idp = saml.IdentityProvider({
    entityID: entityId,
    signingCert: keys.cert.replace(/-----[A-Z ]+-----|\s+/g, ''),
    singleSignOnService: [{ Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect', Location: ssoUrl }],
  });
  const metadataXml = idp.getMetadata();
  mkdirSync(path.dirname(SIM.saml.metadataFile), { recursive: true });
  writeFileSync(SIM.saml.metadataFile, metadataXml);

  /** The SAML attributes the config file's mapping reads (uid, mail, displayName, roles, memberOf). */
  function attributesOf(p: Persona): Record<string, string | string[]> {
    const claims = (overrides.get(p.username) ?? p.claims ?? {}) as Record<string, unknown>;
    const out: Record<string, string | string[]> = { uid: p.username, mail: p.email, displayName: p.name };
    if (Array.isArray(claims.roles)) out.roles = claims.roles.map(String);
    if (typeof claims.memberOf === 'string') out.memberOf = claims.memberOf;
    return out;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', samlUrl);
    const send = (status: number, body: string, type = 'text/html; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
    };
    if (url.pathname === '/metadata') return send(200, metadataXml, 'application/xml');
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      return void res.end();
    }
    if (url.pathname !== '/sso') return send(404, 'not found', 'text/plain');

    let request;
    try {
      request = parseAuthnRequestUrl(`${samlUrl}${req.url}`);
    } catch {
      return send(400, 'bad AuthnRequest', 'text/plain');
    }
    const personas = getPersonas();
    const hint = url.searchParams.get('login_hint');
    const chosen = hint ? personas.find((p) => p.username === hint) : undefined;
    if (hint && !chosen) return send(400, 'unknown persona', 'text/plain');

    if (!chosen) {
      const rows = personas
        .map((p) => {
          const next = new URL(url);
          next.searchParams.set('login_hint', p.username);
          return `<li><a href="${esc(next.pathname + next.search)}"><b>${esc(p.name)}</b> <code>${esc(p.username)}</code></a></li>`;
        })
        .join('');
      return send(
        200,
        `<!doctype html><meta charset="utf-8"><title>Simuleret SAML-login</title>
        <style>body{font:16px system-ui;max-width:42rem;margin:2rem auto;padding:0 1rem}li{list-style:none;margin:.4rem 0}</style>
        <h1>Simuleret SAML-login</h1><p>Test-IdP. Vælg hvem du vil logge ind som.</p><ul>${rows}</ul>`,
      );
    }

    // Only ever answer to this installation.
    const acsUrl = request.acsUrl ?? '';
    if (!acsUrl.startsWith(`${SIM.appUrl}/`)) return send(400, 'unexpected ACS URL', 'text/plain');
    logins.push({ username: chosen.username });
    const response = buildSamlResponse({
      issuer: entityId,
      acsUrl,
      audience: request.spEntityId ?? '',
      nameId: chosen.username,
      attributes: attributesOf(chosen),
      inResponseTo: request.id,
      keys,
    });
    return send(
      200,
      `<!doctype html><meta charset="utf-8"><body onload="document.forms[0].submit()">
       <form method="post" action="${esc(acsUrl)}">
         <input type="hidden" name="SAMLResponse" value="${esc(response)}">
         ${request.relayState ? `<input type="hidden" name="RelayState" value="${esc(request.relayState)}">` : ''}
         <noscript><button>Fortsæt</button></noscript>
       </form>`,
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(SIM.samlPort, '127.0.0.1', resolve);
  });

  return {
    logins,
    setClaims: (username, claims) => {
      if (claims) overrides.set(username, claims);
      else overrides.delete(username);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
