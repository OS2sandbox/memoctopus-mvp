import OpenAI from 'openai';
import { TranscriptSegment } from '@/types';
import { mimeTypeToExt } from './mime';
import { DEFAULT_SPEAKER_LABEL } from '@/lib/audio/speaker-labels';

// ─── Interface ────────────────────────────────────────────────────────────────

export interface TranscriptionProvider {
  transcribe(audioBuffer: Buffer, mimeType: string, durationSeconds?: number): Promise<TranscriptSegment[]>;
}

// ─── Hviske implementation ────────────────────────────────────────────────────
// Hviske (syvai) is the only transcription provider. Talks to the server via its
// OpenAI-compatible /v1/audio/transcriptions endpoint. Two modes:
//   transcribe()    — full batch call, returns timed TranscriptSegment[]
//   transcribeRaw() — lightweight call, returns plain text (for per-utterance live path)

export class HviskeProvider implements TranscriptionProvider {
  private client: OpenAI;
  private model: string;
  private language: string;

  constructor() {
    this.client = new OpenAI({
      // `||` not `??`: an env var set to an empty string (e.g. a deploy .env that
      // ships HVISKE_URL= blank) must fall back to the default, not produce an
      // empty baseURL that fails every request opaquely.
      apiKey: process.env.HVISKE_API_KEY || 'no-key',
      baseURL: process.env.HVISKE_URL || 'http://109.173.238.203:40093/v1',
      // No SDK auto-retries: a retried batch re-uploads ~1 MB of WAV and triples the
      // worst-case lane occupancy under full fan-out. Retries happen at the
      // application level instead (see vad-batch-server.ts), where they run AFTER
      // the first wave drains rather than amplifying an overloaded server.
      maxRetries: 0,
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
      temperature: 0,
    });

    const text = response.text?.trim() ?? '';
    if (!text) return [];

    // Prefer the caller-supplied duration (actual wall-clock recording time) over the
    // buffer-size estimate, which is unreliable because browser bitrates vary widely.
    const duration = durationSeconds ?? estimateAudioDurationSeconds(audioBuffer.length);
    return splitIntoTimedSegments(text, duration);
  }

  async transcribeRaw(
    audioBuffer: Buffer,
    mimeType: string,
    opts?: { timeoutMs?: number },
  ): Promise<{ text: string; latencyMs: number }> {
    const ext = mimeTypeToExt(mimeType);
    const file = new File([new Uint8Array(audioBuffer)], `audio.${ext}`, { type: mimeType });

    const t0 = Date.now();
    const response = await this.client.audio.transcriptions.create({
      model: this.model,
      file,
      language: this.language,
      response_format: 'json',
      temperature: 0,
      // Default 20 s suits the live-caption path; the batch fan-out passes a longer
      // timeout because queueing at full concurrency lengthens individual tails.
    }, { timeout: opts?.timeoutMs ?? 20_000 });

    return { text: response.text ?? '', latencyMs: Date.now() - t0 };
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
    return [{ speaker: DEFAULT_SPEAKER_LABEL, start: 0, end: totalDurationSeconds, text }];
  }

  const wordCounts = sentences.map(s => s.split(/\s+/).filter(Boolean).length);
  const totalWords = wordCounts.reduce((a, b) => a + b, 0);

  let elapsed = 0;
  return sentences.map((sentence, i) => {
    const segDuration = (wordCounts[i] / Math.max(totalWords, 1)) * totalDurationSeconds;
    const segment: TranscriptSegment = {
      speaker: DEFAULT_SPEAKER_LABEL,
      start: elapsed,
      end: elapsed + segDuration,
      text: sentence,
    };
    elapsed += segDuration;
    return segment;
  });
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
