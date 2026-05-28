import { describe, it, expect, beforeEach } from 'vitest';
import { pendingUpload } from './pending-upload';

// ─── pendingUpload ─────────────────────────────────────────────────────────────

describe('pendingUpload', () => {
  beforeEach(() => {
    pendingUpload.clear();
  });

  it('returns null when nothing has been set', () => {
    expect(pendingUpload.get()).toBeNull();
  });

  it('stores and retrieves a pending upload', () => {
    const blob = new Blob(['audio data'], { type: 'audio/webm' });
    const data = { meetingId: 'meet-1', blob, elapsed: 42 };

    pendingUpload.set(data);

    expect(pendingUpload.get()).toEqual(data);
  });

  it('returns null after clear()', () => {
    const blob = new Blob(['data'], { type: 'audio/webm' });
    pendingUpload.set({ meetingId: 'meet-1', blob, elapsed: 10 });
    pendingUpload.clear();

    expect(pendingUpload.get()).toBeNull();
  });

  it('overwrites previous value with set()', () => {
    const blob1 = new Blob(['first'], { type: 'audio/webm' });
    const blob2 = new Blob(['second'], { type: 'audio/webm' });

    pendingUpload.set({ meetingId: 'first', blob: blob1, elapsed: 1 });
    pendingUpload.set({ meetingId: 'second', blob: blob2, elapsed: 2 });

    const stored = pendingUpload.get();
    expect(stored?.meetingId).toBe('second');
    expect(stored?.elapsed).toBe(2);
  });

  it('returns the same object reference that was set', () => {
    const blob = new Blob(['data']);
    const data = { meetingId: 'meet-ref', blob, elapsed: 5 };

    pendingUpload.set(data);

    expect(pendingUpload.get()).toBe(data);
  });

  it('preserves elapsed time correctly', () => {
    const blob = new Blob(['data']);
    pendingUpload.set({ meetingId: 'test', blob, elapsed: 999 });

    expect(pendingUpload.get()?.elapsed).toBe(999);
  });

  it('clear is idempotent — calling twice does not throw', () => {
    expect(() => {
      pendingUpload.clear();
      pendingUpload.clear();
    }).not.toThrow();
  });

  it('get() after clear() is idempotent — returns null', () => {
    pendingUpload.clear();
    expect(pendingUpload.get()).toBeNull();
    expect(pendingUpload.get()).toBeNull();
  });
});
