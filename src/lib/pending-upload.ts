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
