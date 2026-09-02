import { describe, it, expect, beforeEach } from 'vitest';
import {
  setStorageUserId,
  getStorageUserId,
  waitForStorageUserId,
  __resetStorageScope,
} from './scope';

describe('storage scope', () => {
  beforeEach(() => __resetStorageScope());

  it('starts unset and tracks the active user id', () => {
    expect(getStorageUserId()).toBeNull();
    setStorageUserId('u1');
    expect(getStorageUserId()).toBe('u1');
  });

  it('switching to a different user updates the active id', () => {
    setStorageUserId('u1');
    setStorageUserId('u2');
    expect(getStorageUserId()).toBe('u2');
  });

  it('waitForStorageUserId resolves immediately when already set', async () => {
    setStorageUserId('u1');
    await expect(waitForStorageUserId()).resolves.toBe('u1');
  });

  it('waitForStorageUserId waits until a user is set, then resolves with it', async () => {
    const pending = waitForStorageUserId();
    let resolved = false;
    void pending.then(() => { resolved = true; });
    // Not resolved while the scope is unset.
    await Promise.resolve();
    expect(resolved).toBe(false);
    setStorageUserId('u2');
    await expect(pending).resolves.toBe('u2');
  });
});
