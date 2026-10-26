/**
 * Sign-in for the add-in: nested app authentication (NAA). Outlook brokers an
 * Entra access token for OS2taletiltekst's own API, silently when it can, with a
 * Microsoft pop-up the first time consent or a fresh sign-in is needed. The token
 * goes to our server only, in an Authorization header, and is never stored or
 * logged here.
 */

import { getMsal, type MsalGlobal, type MsalNestablePca } from './office';

/**
 * Pinned MSAL build, loaded from a CDN with a subresource-integrity hash, so a
 * tampered file is refused by the browser. 4.30.0 exports
 * createNestablePublicClientApplication; the hash is SHA-384 of that exact file.
 */
const MSAL_URL = 'https://cdn.jsdelivr.net/npm/@azure/msal-browser@4.30.0/lib/msal-browser.min.js';
const MSAL_INTEGRITY = 'sha384-RGxxfG5yRS8DLU7ZJ8OoLhbV/BsJFHyPuMVHrTLbpj3t5Z15LnviJmaznKY/a7LZ';

export interface AddinConfig {
  clientId: string;
  tenantId: string;
  scopes: string[];
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validates /api/outlook/config. Throws a Danish message for the pane. */
export function parseConfig(raw: unknown): AddinConfig {
  const value = (raw ?? {}) as Record<string, unknown>;
  if (value.enabled !== true) {
    throw new Error('OS2taletiltekst er ikke slået til for Outlook endnu. Kontakt jeres IT-administrator.');
  }
  const { clientId, tenantId, scopes } = value;
  if (
    typeof clientId !== 'string' || !GUID_RE.test(clientId)
    || typeof tenantId !== 'string' || !GUID_RE.test(tenantId)
    || !Array.isArray(scopes) || !scopes.every((s) => typeof s === 'string' && s)
  ) {
    throw new Error('Serverens opsætning af Outlook-tilføjelsesprogrammet er ufuldstændig.');
  }
  return { clientId, tenantId, scopes: scopes as string[] };
}

export async function loadConfig(): Promise<AddinConfig> {
  let res: Response;
  try {
    res = await fetch('/api/outlook/config', { cache: 'no-store' });
  } catch {
    throw new Error('Kunne ikke få forbindelse til OS2taletiltekst. Er du på kommunens netværk?');
  }
  if (!res.ok) throw new Error('OS2taletiltekst svarede ikke som forventet. Prøv igen om lidt.');
  return parseConfig(await res.json().catch(() => null));
}

function loadMsal(): Promise<MsalGlobal> {
  const already = getMsal();
  if (already) return Promise.resolve(already);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = MSAL_URL;
    script.integrity = MSAL_INTEGRITY;
    script.crossOrigin = 'anonymous';
    script.onload = () => {
      const msal = getMsal();
      if (msal) resolve(msal);
      else reject(new Error('Microsoft-login kunne ikke startes.'));
    };
    script.onerror = () => reject(new Error('Microsoft-login kunne ikke hentes. Prøv igen om lidt.'));
    document.head.appendChild(script);
  });
}

let client: Promise<MsalNestablePca> | null = null;

function pca(config: AddinConfig): Promise<MsalNestablePca> {
  client ??= loadMsal().then((msal) =>
    msal.createNestablePublicClientApplication({
      // The authority is pinned to one tenant: a token from any other cannot come back.
      auth: { clientId: config.clientId, authority: `https://login.microsoftonline.com/${config.tenantId}` },
    }),
  );
  return client;
}

/** An MSAL error that a sign-in pop-up can fix (consent, a new sign-in, MFA). */
export function needsInteraction(err: unknown): boolean {
  const e = err as { name?: string; errorCode?: string } | null;
  if (!e) return false;
  if (e.name === 'InteractionRequiredAuthError') return true;
  return ['interaction_required', 'consent_required', 'login_required', 'no_account_error']
    .includes(e.errorCode ?? '');
}

export async function getAccessToken(config: AddinConfig): Promise<string> {
  const app = await pca(config);
  const account = app.getActiveAccount() ?? app.getAllAccounts()[0];
  const request = account ? { scopes: config.scopes, account } : { scopes: config.scopes };
  try {
    return (await app.acquireTokenSilent(request)).accessToken;
  } catch (err) {
    if (!needsInteraction(err)) {
      console.warn('[os2taletiltekst] silent sign-in failed:', err);
      throw new Error('Microsoft-login mislykkedes. Prøv igen, eller kontakt jeres IT-administrator.');
    }
  }
  try {
    return (await app.acquireTokenPopup({ scopes: config.scopes })).accessToken;
  } catch (err) {
    console.warn('[os2taletiltekst] sign-in pop-up failed:', err);
    throw new Error('Microsoft-login blev ikke gennemført. Tillad pop-up-vinduet, og prøv igen.');
  }
}
