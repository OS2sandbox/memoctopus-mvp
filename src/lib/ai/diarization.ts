import { Buffer } from 'node:buffer';
import { mimeTypeToExt } from './mime';
import { decodeToMono16k, encodeMono16kWav } from '@/lib/audio/decode-server';

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
  private apiKey: string | undefined;

  constructor() {
    this.baseURL = (process.env.DIARIZATION_URL ?? 'http://localhost:5000').replace(/\/$/, '');
    this.apiKey = process.env.DIARIZATION_API_KEY;
  }

  async diarize(audioBuffer: Buffer, mimeType: string): Promise<SpeakerTurn[]> {
    // The pyannote service decodes only PCM WAV. Callers now send the original
    // compressed recording (small browser/bot upload — the win), so decode anything
    // that isn't already WAV to 16 kHz mono WAV here with ffmpeg before forwarding.
    // This keeps diarization working regardless of the service version, and the
    // app→service hop is local in production (docker-compose). Fail-soft: if the
    // local decode fails, send the original and let the service attempt it.
    let buffer = audioBuffer;
    let outMime = mimeType;
    if (!/wav/i.test(mimeType)) {
      try {
        buffer = encodeMono16kWav(await decodeToMono16k(audioBuffer));
        outMime = 'audio/wav';
      } catch (err) {
        console.error('[diarize] server-side decode failed, sending original:', err);
      }
    }

    const ext = mimeTypeToExt(outMime, 'wav');
    const file = new File([new Uint8Array(buffer)], `audio.${ext}`, { type: outMime });
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

// ─── Active provider ──────────────────────────────────────────────────────────

let _provider: DiarizationProvider | null = null;

export function getDiarizationProvider(): DiarizationProvider {
  if (!_provider) _provider = new PyannoteProvider();
  return _provider;
}

export function setDiarizationProvider(provider: DiarizationProvider): void {
  _provider = provider;
}
