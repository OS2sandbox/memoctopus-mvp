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
