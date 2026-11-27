import { describe, it, expect, beforeEach } from 'vitest';
import {
  setPendingUploadFile,
  takePendingUploadFile,
  clearPendingUploads,
} from './pending-upload';

// ─── clearPendingUploads (sign-out isolation) ──────────────────────────────────

describe('takePendingUploadFile', () => {
  beforeEach(() => clearPendingUploads());

  it('hands the picked file over once', () => {
    const file = new File(['audio'], 'recording.webm', { type: 'audio/webm' });
    setPendingUploadFile(file);

    expect(takePendingUploadFile()).toBe(file);
    expect(takePendingUploadFile()).toBeNull();
  });
});

describe('clearPendingUploads', () => {
  beforeEach(() => clearPendingUploads());

  it('drops a picked upload file so the next user cannot consume it', () => {
    const file = new File(['secret audio'], 'recording.webm', { type: 'audio/webm' });
    setPendingUploadFile(file);

    clearPendingUploads();

    expect(takePendingUploadFile()).toBeNull();
  });
});
