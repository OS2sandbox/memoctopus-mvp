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
      // Fall back to a single segment with the full text
      return [
        {
          speaker: 'Taler 1',
          start: 0,
          end: 0,
          text: response.text,
        },
      ];
    }

    // Map Whisper segments — Whisper doesn't do speaker diarization natively,
    // so we assign speakers heuristically based on long pauses (>2s gap).
    const segments: TranscriptSegment[] = [];
    let currentSpeaker = 1;
    let lastEnd = 0;

    for (const seg of response.segments) {
      const gap = seg.start - lastEnd;
      if (gap > 2 && segments.length > 0) {
        currentSpeaker = currentSpeaker === 1 ? 2 : 1;
      }
      segments.push({
        speaker: `Taler ${currentSpeaker}`,
        start: seg.start,
        end: seg.end,
        text: seg.text.trim(),
      });
      lastEnd = seg.end;
    }

    return segments;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── Active provider (swap here to change implementation) ────────────────────

let _provider: TranscriptionProvider | null = null;

export function getTranscriptionProvider(): TranscriptionProvider {
  if (!_provider) {
    _provider = new WhisperProvider();
  }
  return _provider;
}

export function setTranscriptionProvider(provider: TranscriptionProvider): void {
  _provider = provider;
}
