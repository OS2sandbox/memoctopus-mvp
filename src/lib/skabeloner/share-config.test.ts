import { describe, it, expect, afterEach } from 'vitest';
import { getShareConfig } from './share-config';

const { SKABELON_SHARE_CODE } = process.env;

afterEach(() => {
  // Restore the original env between cases.
  if (SKABELON_SHARE_CODE === undefined) delete process.env.SKABELON_SHARE_CODE;
  else process.env.SKABELON_SHARE_CODE = SKABELON_SHARE_CODE;
});

describe('getShareConfig', () => {
  it('defaults to code on', () => {
    delete process.env.SKABELON_SHARE_CODE;
    expect(getShareConfig()).toEqual({ code: true });
  });

  it('disables code only when explicitly "false"', () => {
    process.env.SKABELON_SHARE_CODE = 'false';
    expect(getShareConfig().code).toBe(false);
    process.env.SKABELON_SHARE_CODE = 'true';
    expect(getShareConfig().code).toBe(true);
  });
});
