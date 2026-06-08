import OpenAI from 'openai';
import { TranscriptSegment } from '@/types';

// ─── Interface ───────────────────────────────────────────────────────────────

export interface TranscriptionProvider {
  transcribe(audioBuffer: Buffer, mimeType: string): Promise<TranscriptSegment[]>;
}

// ─── ElevenLabs implementation ────────────────────────────────────────────────
// Uses scribe_v2 with speaker diarization for accurate multi-speaker transcription.

export class ElevenLabsProvider implements TranscriptionProvider {
  async transcribe(audioBuffer: Buffer, mimeType: string): Promise<TranscriptSegment[]> {
    const ext = mimeTypeToExt(mimeType);

    const formData = new FormData();
    formData.append('file', new Blob([new Uint8Array(audioBuffer)], { type: mimeType }), `audio.${ext}`);
    formData.append('model_id', 'scribe_v2');
    formData.append('diarize', 'true');
    formData.append('language_code', 'da');
    formData.append('timestamps_granularity', 'word');

    const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY! },
      body: formData,
    });

    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new Error(`ElevenLabs STT error ${res.status}: ${err}`);
    }

    const data = await res.json() as ElevenLabsSTTResponse;

    if (!data.words || data.words.length === 0) {
      return [{ speaker: 'Taler 1', start: 0, end: 0, text: data.text }];
    }

    return wordsToSegments(data.words);
  }
}

interface ElevenLabsSTTResponse {
  text: string;
  words?: ElevenLabsWord[];
}

interface ElevenLabsWord {
  text: string;
  start: number;
  end: number;
  type: 'word' | 'spacing';
  speaker_id?: string;
}

function wordsToSegments(words: ElevenLabsWord[]): TranscriptSegment[] {
  const wordItems = words.filter((w) => w.type === 'word');
  if (wordItems.length === 0) return [];

  const segments: TranscriptSegment[] = [];
  let speaker = speakerLabel(wordItems[0].speaker_id ?? 'speaker_0');
  let start = wordItems[0].start;
  let end = wordItems[0].end;
  let texts: string[] = [wordItems[0].text];

  for (let i = 1; i < wordItems.length; i++) {
    const w = wordItems[i];
    const sp = speakerLabel(w.speaker_id ?? 'speaker_0');

    if (sp !== speaker || w.start - end > 2.5) {
      segments.push({ speaker, start, end, text: texts.join(' ').trim() });
      speaker = sp;
      start = w.start;
      texts = [w.text];
    } else {
      texts.push(w.text);
    }
    end = w.end;
  }

  if (texts.length > 0) {
    segments.push({ speaker, start, end, text: texts.join(' ').trim() });
  }

  return segments.filter((s) => s.text);
}

function speakerLabel(speakerId: string): string {
  const match = speakerId.match(/\d+/);
  const num = match ? parseInt(match[0]) + 1 : 1;
  return `Taler ${num}`;
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
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    });

    if (response.segments && response.segments.length > 0) {
      return segmentsWithHeuristicDiarization(response.segments);
    }

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
// TRANSCRIPTION_PROVIDER env var selects the provider:
//   elevenlabs (default) — scribe_v2 with speaker diarization
//   hviske               — syvai/hviske-v5.1 via hviske server

let _provider: TranscriptionProvider | null = null;

export function getTranscriptionProvider(): TranscriptionProvider {
  if (!_provider) {
    const p = process.env.TRANSCRIPTION_PROVIDER;
    if (p === 'hviske') _provider = new HviskeProvider();
    else _provider = new ElevenLabsProvider();
  }
  return _provider;
}

export function setTranscriptionProvider(provider: TranscriptionProvider): void {
  _provider = provider;
}
