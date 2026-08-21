import { describe, it, expect } from 'vitest';
import * as SignInPage from './page';

// Guards the single most deletable line in the generic-OIDC feature. Without
// `force-dynamic` Next prerenders this page at build time and freezes the
// provider list — including the OIDC display name — into the RSC payload, so
// runtime OIDC_* configuration would silently do nothing.
describe('(marketing)/page route config', () => {
  it('is rendered dynamically so auth config is read per request', () => {
    expect(SignInPage.dynamic).toBe('force-dynamic');
  });
});
