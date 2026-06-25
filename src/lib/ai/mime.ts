// Maps an audio MIME type to a file extension. Shared by the STT and diarization
// providers, which both wrap an audio Buffer in a named File before upload — the
// extension is what the receiving server uses to pick a decoder.
export function mimeTypeToExt(mimeType: string, fallback = 'webm'): string {
  const map: Record<string, string> = {
    'audio/webm': 'webm',
    'audio/mp4': 'mp4',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/flac': 'flac',
    'audio/x-m4a': 'm4a',
  };
  return map[mimeType] ?? fallback;
}
