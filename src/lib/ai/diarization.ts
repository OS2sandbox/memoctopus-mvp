import { Buffer } from 'node:buffer';
import { Agent } from 'undici';
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

function getDiarizationTimeoutMs(): number {
  const value = Number(process.env.DIARIZATION_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 300_000;
}

type FetchInitWithDispatcher = RequestInit & {
  dispatcher: Agent;
};

// ─── pyannote implementation ──────────────────────────────────────────────────
// Talks to the pyannote.audio diarization service (FastAPI wrapper around
// speaker-diarization-community-1). As of the ensemble migration this is co-hosted
// ON the hviske server itself (`POST /diarize`, same host:port as transcription) —
// so by default we derive the base URL from HVISKE_URL (minus its `/v1` suffix) and
// no separate service / SSH tunnel is needed. DIARIZATION_URL still overrides for
// split deployments (e.g. the standalone diarization-service in docker-compose).

export class PyannoteProvider implements DiarizationProvider {
  private baseURL: string;
  private apiKey: string | undefined;

  constructor() {
    // `||` not `??`: a blank DIARIZATION_URL (empty string from a deploy .env) must
    // fall back to the derived default rather than yield an empty baseURL. The
    // fallback strips a trailing `/v1` from the hviske origin because /diarize lives
    // at the server root, not under the OpenAI-compatible /v1 prefix.
    const hviskeOrigin = (process.env.HVISKE_URL || 'http://109.173.238.203:40093/v1').replace(/\/v1\/?$/, '');
    this.baseURL = (process.env.DIARIZATION_URL || hviskeOrigin).replace(/\/$/, '');
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

    // Multipart field name is `file` — the co-hosted hviske /diarize endpoint
    // requires it (the legacy standalone service accepted `audio`; it now accepts
    // both, see diarization-service/app.py).
    form.append('file', file);

    const timeoutMs = getDiarizationTimeoutMs();

    // Node's fetch uses undici underneath. AbortSignal.timeout controls our own
    // request timeout, but undici also has headers/body timers. CPU diarization can
    // legitimately take longer than the default headers timeout before returning
    // response headers, so configure the dispatcher to match DIARIZATION_TIMEOUT_MS.
    const dispatcher = new Agent({
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });

    try {
      const res = await fetch(`${this.baseURL}/diarize`, {
        method: 'POST',
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : undefined,
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
        dispatcher,
      } as FetchInitWithDispatcher);

      if (!res.ok) {
        throw new Error(`Diarization service returned ${res.status}`);
      }

      const data = (await res.json()) as { turns?: SpeakerTurn[] };
      return Array.isArray(data.turns) ? data.turns : [];
    } finally {
      await dispatcher.close();
    }
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
