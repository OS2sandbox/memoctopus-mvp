import OpenAI from 'openai';
import { TranscriptSegment } from '@/types';

// ─── Interface ────────────────────────────────────────────────────────────────

export interface TranscriptionProvider {
  transcribe(audioBuffer: Buffer, mimeType: string, durationSeconds?: number): Promise<TranscriptSegment[]>;
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

  async transcribe(audioBuffer: Buffer, mimeType: string, durationSeconds?: number): Promise<TranscriptSegment[]> {
    const ext = mimeTypeToExt(mimeType);
    const file = new File([new Uint8Array(audioBuffer)], `audio.${ext}`, { type: mimeType });

    const response = await this.client.audio.transcriptions.create({
      model: this.model,
      file,
      language: this.language,
      response_format: 'json',
    });

    const text = response.text?.trim() ?? '';
    if (!text) return [];

    // Prefer the caller-supplied duration (actual wall-clock recording time) over the
    // buffer-size estimate, which is unreliable because browser bitrates vary widely.
    const duration = durationSeconds ?? estimateAudioDurationSeconds(audioBuffer.length);
    return splitIntoTimedSegments(text, duration);
  }

  async transcribeRaw(audioBuffer: Buffer, mimeType: string): Promise<string> {
    const ext = mimeTypeToExt(mimeType);
    const file = new File([new Uint8Array(audioBuffer)], `audio.${ext}`, { type: mimeType });

    const response = await this.client.audio.transcriptions.create({
      model: this.model,
      file,
      language: this.language,
      response_format: 'json',
    }, { timeout: 12_000 });

    return response.text ?? '';
  }
}

// ─── Timestamp estimation ─────────────────────────────────────────────────────
// hviske returns plain text without segment timestamps, so we estimate them from
// audio buffer size and distribute proportionally by word count across sentences.

function estimateAudioDurationSeconds(bufferBytes: number): number {
  // WebM/Opus at ~64 kbps average ≈ 8 000 bytes/s
  return Math.max(1, bufferBytes / 8_000);
}

function splitIntoTimedSegments(text: string, totalDurationSeconds: number): TranscriptSegment[] {
  // Split on sentence boundaries, retaining the terminal punctuation
  const sentences = (text.match(/[^.!?]+[.!?]+/g) ?? [text])
    .map(s => s.trim())
    .filter(Boolean);

  if (sentences.length === 0) {
    return [{ speaker: 'Taler 1', start: 0, end: totalDurationSeconds, text }];
  }

  const wordCounts = sentences.map(s => s.split(/\s+/).filter(Boolean).length);
  const totalWords = wordCounts.reduce((a, b) => a + b, 0);

  let elapsed = 0;
  return sentences.map((sentence, i) => {
    const segDuration = (wordCounts[i] / Math.max(totalWords, 1)) * totalDurationSeconds;
    const segment: TranscriptSegment = {
      speaker: 'Taler 1',
      start: elapsed,
      end: elapsed + segDuration,
      text: sentence,
    };
    elapsed += segDuration;
    return segment;
  });
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
