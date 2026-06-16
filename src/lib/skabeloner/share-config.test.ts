import { describe, it, expect, afterEach } from 'vitest';
import { getShareConfig } from './share-config';

const { SKABELON_SHARE_CODE, SKABELON_SHARE_LINK } = process.env;

afterEach(() => {
  // Restore the original env between cases.
  if (SKABELON_SHARE_CODE === undefined) delete process.env.SKABELON_SHARE_CODE;
  else process.env.SKABELON_SHARE_CODE = SKABELON_SHARE_CODE;
  if (SKABELON_SHARE_LINK === undefined) delete process.env.SKABELON_SHARE_LINK;
  else process.env.SKABELON_SHARE_LINK = SKABELON_SHARE_LINK;
});

describe('getShareConfig', () => {
  it('defaults to code on, link off', () => {
    delete process.env.SKABELON_SHARE_CODE;
    delete process.env.SKABELON_SHARE_LINK;
    expect(getShareConfig()).toEqual({ code: true, link: false });
  });

  it('disables code only when explicitly "false"', () => {
    process.env.SKABELON_SHARE_CODE = 'false';
    expect(getShareConfig().code).toBe(false);
    process.env.SKABELON_SHARE_CODE = 'true';
    expect(getShareConfig().code).toBe(true);
  });

  it('enables link only when explicitly "true"', () => {
    process.env.SKABELON_SHARE_LINK = 'true';
    expect(getShareConfig().link).toBe(true);
    process.env.SKABELON_SHARE_LINK = '1';
    expect(getShareConfig().link).toBe(false);
  });
});
