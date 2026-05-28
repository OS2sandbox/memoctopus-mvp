import OpenAI from 'openai';
import { TranscriptSegment } from '@/types';

// ─── Interface ───────────────────────────────────────────────────────────────

export interface TranscriptionProvider {
  transcribe(audioBuffer: Buffer, mimeType: string): Promise<TranscriptSegment[]>;
}

// ─── Whisper implementation ──────────────────────────────────────────────────

export class WhisperProvider implements TranscriptionProvider {
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY!,
    });
  }

  async transcribe(audioBuffer: Buffer, mimeType: string): Promise<TranscriptSegment[]> {
    // Determine file extension from mime type
    const ext = mimeTypeToExt(mimeType);

    // OpenAI SDK needs a File-like object
    const file = new File([new Uint8Array(audioBuffer)], `audio.${ext}`, { type: mimeType });

    const response = await this.client.audio.transcriptions.create({
      model: 'whisper-1',
      file,
      language: 'da',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    });

    if (!response.segments || response.segments.length === 0) {
      return [{ speaker: 'Taler 1', start: 0, end: 0, text: response.text }];
    }

    return segmentsWithHeuristicDiarization(response.segments);
  }
}

// ─── Hviske-v5.1 implementation ──────────────────────────────────────────────
// Talks to a vLLM instance serving syvai/hviske-v5.1 via its OpenAI-compatible
// /v1/audio/transcriptions endpoint.

export class HviskeProvider implements TranscriptionProvider {
  private client: OpenAI;
  private model: string;
  private language: string;

  constructor() {
    this.client = new OpenAI({
      // vLLM doesn't require a real key, but the SDK requires a non-empty string.
      apiKey: process.env.VLLM_API_KEY ?? 'no-key',
      baseURL: process.env.VLLM_URL ?? 'http://localhost:8001/v1',
    });
    this.model = process.env.VLLM_MODEL ?? 'syvai/hviske-v5.1';
    this.language = process.env.ASR_LANGUAGE ?? 'da';
  }

  async transcribe(audioBuffer: Buffer, mimeType: string): Promise<TranscriptSegment[]> {
    const ext = mimeTypeToExt(mimeType);
    const file = new File([new Uint8Array(audioBuffer)], `audio.${ext}`, { type: mimeType });

    const response = await this.client.audio.transcriptions.create({
      model: this.model,
      file,
      language: this.language,
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    });

    if (response.segments && response.segments.length > 0) {
      return segmentsWithHeuristicDiarization(response.segments);
    }

    return [{ speaker: 'Taler 1', start: 0, end: 0, text: response.text }];
  }
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function segmentsWithHeuristicDiarization(
  rawSegments: Array<{ start: number; end: number; text: string }>,
): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  let currentSpeaker = 1;
  let lastEnd = 0;
  for (const seg of rawSegments) {
    if (seg.start - lastEnd > 2 && out.length > 0) {
      currentSpeaker = currentSpeaker === 1 ? 2 : 1;
    }
    out.push({ speaker: `Taler ${currentSpeaker}`, start: seg.start, end: seg.end, text: seg.text.trim() });
    lastEnd = seg.end;
  }
  return out;
}

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
// Set TRANSCRIPTION_PROVIDER=hviske (and VLLM_URL) to use hviske-v5.1.
// Defaults to whisper-1 via OpenAI when unset.

let _provider: TranscriptionProvider | null = null;

export function getTranscriptionProvider(): TranscriptionProvider {
  if (!_provider) {
    _provider =
      process.env.TRANSCRIPTION_PROVIDER === 'hviske'
        ? new HviskeProvider()
        : new WhisperProvider();
  }
  return _provider;
}

export function setTranscriptionProvider(provider: TranscriptionProvider): void {
  _provider = provider;
}
