import OpenAI from 'openai';
import { TranscriptSegment } from '@/types';

// ─── Interface ───────────────────────────────────────────────────────────────

export interface TranscriptionProvider {
  transcribe(audioBuffer: Buffer, mimeType: string): Promise<TranscriptSegment[]>;
}

// ─── Hviske implementation ────────────────────────────────────────────────────
// Talks to the hviske server via its OpenAI-compatible /v1/audio/transcriptions
// endpoint. Two modes:
//   transcribe()    — full batch call, returns diarized TranscriptSegment[]
//   transcribeRaw() — lightweight call, returns plain text (for per-utterance live path)

export class HviskeProvider implements TranscriptionProvider {
  private client: OpenAI;
  private model: string;
  private language: string;

  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.HVISKE_API_KEY ?? 'no-key',
      baseURL: process.env.HVISKE_URL ?? 'http://74.48.78.46:58780/v1',
    });
    this.model = process.env.HVISKE_MODEL ?? 'syvai/hviske-v5.1';
    this.language = process.env.ASR_LANGUAGE ?? 'da';
  }

  async transcribe(audioBuffer: Buffer, mimeType: string): Promise<TranscriptSegment[]> {
    const ext = mimeTypeToExt(mimeType);
    const file = new File([new Uint8Array(audioBuffer)], `audio.${ext}`, { type: mimeType });

    const response = await this.client.audio.transcriptions.create({
      model: this.model,
      file,
      language: this.language,
      response_format: 'json',
    });

    return [{ speaker: 'Taler 1', start: 0, end: 0, text: response.text }];
  }

  async transcribeRaw(audioBuffer: Buffer, mimeType: string): Promise<string> {
    const ext = mimeTypeToExt(mimeType);
    const file = new File([new Uint8Array(audioBuffer)], `audio.${ext}`, { type: mimeType });

    const response = await this.client.audio.transcriptions.create({
      model: this.model,
      file,
      language: this.language,
      response_format: 'json',
    });

    return response.text ?? '';
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
  return map[mimeType] ?? 'webm';
}

// ─── Active provider ──────────────────────────────────────────────────────────

let _provider: TranscriptionProvider | null = null;

export function getTranscriptionProvider(): TranscriptionProvider {
  if (!_provider) _provider = new HviskeProvider();
  return _provider;
}

export function setTranscriptionProvider(provider: TranscriptionProvider): void {
  _provider = provider;
}
