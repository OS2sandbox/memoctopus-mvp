import { describe, it, expect, beforeEach } from 'vitest';
import {
  pendingUpload,
  setPendingUploadFiles,
  takePendingUploadFiles,
  clearPendingUploads,
} from './pending-upload';

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

// ─── clearPendingUploads (sign-out isolation) ──────────────────────────────────

describe('clearPendingUploads', () => {
  beforeEach(() => clearPendingUploads());

  it('drops picked upload files so the next user cannot consume them', () => {
    const file = new File(['secret audio'], 'recording.webm', { type: 'audio/webm' });
    setPendingUploadFiles([file]);

    clearPendingUploads();

    expect(takePendingUploadFiles()).toEqual([]);
  });

  it('also clears the pending recording blob', () => {
    pendingUpload.set({ meetingId: 'm', blob: new Blob(['x']), elapsed: 1 });

    clearPendingUploads();

    expect(pendingUpload.get()).toBeNull();
  });
});

// ─── picked upload files ───────────────────────────────────────────────────────

describe('setPendingUploadFiles / takePendingUploadFiles', () => {
  beforeEach(() => clearPendingUploads());

  it('hands over every picked file, in the order picked', () => {
    const files = ['a.mp3', 'b.mp3', 'c.mp3'].map((n) => new File(['x'], n));
    setPendingUploadFiles(files);

    expect(takePendingUploadFiles().map((f) => f.name)).toEqual(['a.mp3', 'b.mp3', 'c.mp3']);
  });

  it('hands the files over once', () => {
    setPendingUploadFiles([new File(['x'], 'a.mp3')]);
    takePendingUploadFiles();

    expect(takePendingUploadFiles()).toEqual([]);
  });
});
