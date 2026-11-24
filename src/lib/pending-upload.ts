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
// Holds the files picked on the dashboard so /meeting/new can consume them
// without serialisation (File objects cannot be stored in sessionStorage). Several
// files are one meeting recorded in parts; their order is the order picked until
// the user changes it on the ordering step.

let _uploadFiles: File[] = [];

export function setPendingUploadFiles(files: File[]): void {
  _uploadFiles = files;
}

export function takePendingUploadFiles(): File[] {
  const files = _uploadFiles;
  _uploadFiles = [];
  return files;
}

// Clear all in-memory pending data. Called on sign-out so a file/blob picked by one
// user can never be consumed by the next user in the same tab (no full reload to
// reset these module singletons).
export function clearPendingUploads(): void {
  _pending = null;
  _uploadFiles = [];
}
