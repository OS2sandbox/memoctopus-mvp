import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { resetAuthConfigCache } from '@/lib/auth/config-file';
import * as SignInPage from './page';

describe('(marketing)/page route config', () => {
  it('is rendered dynamically so auth config is read per request', () => {
    expect(SignInPage.dynamic).toBe('force-dynamic');
  });
});

// The page and the server read the providers from the same place; the file's providers must
// reach the page as plain data, with no secret.
describe('(marketing)/page providers', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'signin-'));
    vi.stubEnv('EMAIL_PASSWORD_ENABLED', 'false');
    vi.stubEnv('BETTER_AUTH_URL', 'https://referat.example');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    resetAuthConfigCache();
  });

  it('passes every provider of AUTH_CONFIG_FILE, SAML included, to the form', () => {
    const file = path.join(dir, 'auth.json');
    writeFileSync(
      file,
      JSON.stringify({
        providers: [
          { type: 'oidc', id: 'fka', label: 'FKA', clientId: 'a', clientSecret: 'very-secret', discoveryUrl: 'https://i.example/.well-known/openid-configuration' },
          { type: 'saml', id: 'os2faktor', label: 'OS2faktor', entryPoint: 'https://i.example/sso', idpEntityId: 'https://i.example', cert: 'MIIC' },
        ],
      }),
    );
    vi.stubEnv('AUTH_CONFIG_FILE', file);
    resetAuthConfigCache();

    const tree = SignInPage.default() as unknown as { props: { children: unknown } };
    const json = JSON.stringify(tree, (_k, v) => (typeof v === 'function' ? undefined : v));
    expect(json).toContain('"kind":"oauth2","id":"fka","label":"FKA"');
    expect(json).toContain('"kind":"sso","id":"os2faktor","label":"OS2faktor"');
    expect(json).not.toContain('very-secret');
    expect(json).not.toContain('MIIC');
    expect(json).toContain('"emailPasswordEnabled":false');
  });
});
