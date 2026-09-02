export interface PendingUpload {
  meetingId: string;
  blob: Blob;
  elapsed: number;
}

let _pending: PendingUpload | null = null;

export const pendingUpload = {
  set(data: PendingUpload) {
    _pending = data;
  },
  get(): PendingUpload | null {
    return _pending;
  },
  clear() {
    _pending = null;
  },
};

// ── Upload-confirm file store ──────────────────────────────────────────────────
// Holds the File picked on the dashboard so it can be consumed by /meeting/new
// without serialisation (File objects cannot be stored in sessionStorage).

let _uploadFile: File | null = null;

export function setPendingUploadFile(f: File): void {
  _uploadFile = f;
}

export function takePendingUploadFile(): File | null {
  const f = _uploadFile;
  _uploadFile = null;
  return f;
}

// Clear all in-memory pending data. Called on sign-out so a file/blob picked by one
// user can never be consumed by the next user in the same tab (no full reload to
// reset these module singletons).
export function clearPendingUploads(): void {
  _pending = null;
  _uploadFile = null;
}
