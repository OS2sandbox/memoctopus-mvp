import { Buffer } from 'node:buffer';

// ─── Interface ────────────────────────────────────────────────────────────────
// Speaker diarization runs as a separate acoustic pass over the full recording.
// hviske (the STT model) does not diarize, so this fills in "who spoke when" and
// the result is merged onto transcript segments by time-overlap (see
// src/lib/audio/merge-speakers.ts). Diarization is language-agnostic.

export interface SpeakerTurn {
  speaker: string; // raw diarizer label, e.g. "SPEAKER_00"
  start: number;   // seconds from start of recording
  end: number;
}

export interface DiarizationProvider {
  diarize(audioBuffer: Buffer, mimeType: string): Promise<SpeakerTurn[]>;
}

// ─── pyannote implementation ──────────────────────────────────────────────────
// Talks to the self-hosted pyannote.audio service (FastAPI wrapper around
// speaker-diarization-community-1). Configured via DIARIZATION_URL +
// DIARIZATION_API_KEY, mirroring how HviskeProvider is configured.

export class PyannoteProvider implements DiarizationProvider {
  private baseURL: string;
  private apiKey: string;

  constructor() {
    this.baseURL = (process.env.DIARIZATION_URL ?? 'http://localhost:5000').replace(/\/$/, '');
    this.apiKey = process.env.DIARIZATION_API_KEY ?? '';
  }

  async diarize(audioBuffer: Buffer, mimeType: string): Promise<SpeakerTurn[]> {
    const ext = mimeTypeToExt(mimeType);
    const file = new File([new Uint8Array(audioBuffer)], `audio.${ext}`, { type: mimeType });
    const form = new FormData();
    form.append('audio', file);

    const res = await fetch(`${this.baseURL}/diarize`, {
      method: 'POST',
      headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : undefined,
      body: form,
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) {
      throw new Error(`Diarization service returned ${res.status}`);
    }

    const data = (await res.json()) as { turns?: SpeakerTurn[] };
    return Array.isArray(data.turns) ? data.turns : [];
  }
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function mimeTypeToExt(mimeType: string): string {
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
  return map[mimeType] ?? 'wav';
}

// ─── Active provider ──────────────────────────────────────────────────────────

let _provider: DiarizationProvider | null = null;

export function getDiarizationProvider(): DiarizationProvider {
  if (!_provider) _provider = new PyannoteProvider();
  return _provider;
}

export function setDiarizationProvider(provider: DiarizationProvider): void {
  _provider = provider;
}
