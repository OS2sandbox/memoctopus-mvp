import type { Skabelon } from '@/types';

// The subset of a Skabelon that travels when sharing: identity-free fields only
// (no id, isDefault, or timestamps — those belong to whoever imports the copy).
export type ShareableSkabelon = Pick<
  Skabelon,
  | 'name'
  | 'description'
  | 'prompt'
  | 'includeDeltagere'
  | 'includeBeslutningspunkter'
  | 'includeDagsorden'
  | 'includeDato'
>;

// A versioned prefix lets us recognise our own codes and evolve the format later.
const PREFIX = 'skab1_';

function toBase64Url(text: string): string {
  let b64: string;
  if (typeof Buffer !== 'undefined') {
    b64 = Buffer.from(text, 'utf-8').toString('base64');
  } else {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (const byte of bytes) bin += String.fromCharCode(byte);
    b64 = btoa(bin);
  }
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(code: string): string {
  const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(b64, 'base64').toString('utf-8');
  }
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// Encode a template into a portable, self-contained code that can be copied and
// pasted anywhere — no server lookup needed to reconstruct it.
export function encodeSkabelonCode(s: ShareableSkabelon): string {
  const payload = {
    name: s.name,
    description: s.description,
    prompt: s.prompt,
    includeDeltagere: s.includeDeltagere,
    includeBeslutningspunkter: s.includeBeslutningspunkter,
    includeDagsorden: s.includeDagsorden,
    includeDato: s.includeDato,
  };
  return PREFIX + toBase64Url(JSON.stringify(payload));
}

// Decode a code produced by encodeSkabelonCode. Returns null for anything that
// isn't a well-formed code, so callers can fall back to other paste formats.
export function decodeSkabelonCode(raw: string): ShareableSkabelon | null {
  const code = raw.trim();
  if (!code.startsWith(PREFIX)) return null;
  try {
    const obj = JSON.parse(fromBase64Url(code.slice(PREFIX.length)));
    if (!obj || typeof obj.name !== 'string') return null;
    return {
      name: obj.name,
      description: typeof obj.description === 'string' ? obj.description : '',
      prompt: typeof obj.prompt === 'string' ? obj.prompt : '',
      includeDeltagere: !!obj.includeDeltagere,
      includeBeslutningspunkter: !!obj.includeBeslutningspunkter,
      includeDagsorden: !!obj.includeDagsorden,
      includeDato: !!obj.includeDato,
    };
  } catch {
    return null;
  }
}

// Pull the share token out of an old-style import link (any origin), so pasting
// either a code or a link works. Returns null if no token is present.
export function extractImportToken(raw: string): string | null {
  const m = raw.trim().match(/skabeloner\/import\/([^/?#\s]+)/);
  return m ? m[1] : null;
}
