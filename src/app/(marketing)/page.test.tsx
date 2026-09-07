import { describe, it, expect } from 'vitest';
import * as SignInPage from './page';

describe('(marketing)/page route config', () => {
  it('is rendered dynamically so auth config is read per request', () => {
    expect(SignInPage.dynamic).toBe('force-dynamic');
  });
});
