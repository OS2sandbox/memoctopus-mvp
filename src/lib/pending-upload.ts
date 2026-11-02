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

// Clear the in-memory pending file. Called on sign-out so a file picked by one
// user can never be consumed by the next user in the same tab (no full reload to
// reset these module singletons).
export function clearPendingUploads(): void {
  _uploadFile = null;
}
