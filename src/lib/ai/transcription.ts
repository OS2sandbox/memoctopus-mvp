import OpenAI from 'openai';
import { TranscriptSegment } from '@/types';
import { mimeTypeToExt } from './mime';
import { DEFAULT_SPEAKER_LABEL, speakerLabel } from '@/lib/audio/speaker-labels';

// ─── Interface ────────────────────────────────────────────────────────────────

export interface TranscriptionProvider {
  transcribe(audioBuffer: Buffer, mimeType: string, durationSeconds?: number): Promise<TranscriptSegment[]>;
}

// ─── Backend selection ──────────────────────────────────────────────────────
// Mirrors the chat-LLM selector (src/lib/ai/llm-client.ts). Precedence:
//   1. HVISKE_URL set     → use it (any OpenAI-compatible STT endpoint), with HVISKE_MODEL
//   2. HVISKE_API_KEY set → hosted syv.ai platform (syv-transcribe)
//   3. neither            → self-hosted vLLM ASR (syvai/hviske-ensemble) at vllm-asr:8000
// HVISKE_MODEL overrides the model id. So a deploy "just works" against the hosted
// API the moment a key is supplied, and falls back to the self-hosted model otherwise.

const SYVAI_BASE_URL = 'https://platform.syv.ai/v1';
const LOCAL_ASR_BASE_URL = 'http://vllm-asr:8000/v1';
const SYVAI_MODEL = 'syv-transcribe';
const LOCAL_ASR_MODEL = 'syvai/hviske-ensemble';

function hasHviskeKey(): boolean {
  return !!process.env.HVISKE_API_KEY?.trim();
}

// Resolved STT endpoint: HVISKE_URL wins; else the hosted syv.ai API when a key is
// configured; else the self-hosted vLLM ASR.
export function hviskeBaseURL(): string {
  const explicit = process.env.HVISKE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  return hasHviskeKey() ? SYVAI_BASE_URL : LOCAL_ASR_BASE_URL;
}

// Resolved model id: HVISKE_MODEL wins; else syv-transcribe on the hosted syv.ai
// platform, or the self-hosted hviske-ensemble for any other endpoint.
function hviskeModel(): string {
  return process.env.HVISKE_MODEL?.trim()
    || (hviskeBaseURL().includes('platform.syv.ai') ? SYVAI_MODEL : LOCAL_ASR_MODEL);
}

// Whether the STT endpoint returns diarization + segment timestamps inline (one
// call: text + speaker + start/end), so the app skips both the VAD fan-out and the
// separate diarization pass. Only the hosted syv.ai platform supports this; the
// self-hosted hviske transcribes only (and diarizes via the separate /diarize
// service). HVISKE_DIARIZE=true|false overrides the auto-detection.
export function isEnsembleDiarization(): boolean {
  const explicit = process.env.HVISKE_DIARIZE?.trim().toLowerCase();
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  return hviskeBaseURL().includes('platform.syv.ai');
}

// Shape of a single segment in the verbose_json response (extra Whisper fields omitted).
interface VerboseSegment {
  start?: number;
  end?: number;
  text?: string;
  speaker?: number | null;
}

// ─── Hviske implementation ────────────────────────────────────────────────────
// Hviske (syvai) is the only transcription provider. Talks to the server via its
// OpenAI-compatible /v1/audio/transcriptions endpoint. Modes:
//   transcribe()         — full batch call, returns timed TranscriptSegment[]
//   transcribeRaw()      — lightweight call, returns plain text (per-utterance live path)
//   transcribeEnsemble() — one call returning diarized, timestamped segments (platform.syv.ai)

export class HviskeProvider implements TranscriptionProvider {
  private client: OpenAI;
  private model: string;
  private language: string;
  // Kept alongside the OpenAI client because transcribeEnsemble() bypasses the SDK
  // (the `diarize` form field is a non-OpenAI extension the SDK won't pass through).
  private baseURL: string;
  private apiKey: string;

  constructor() {
    this.apiKey = process.env.HVISKE_API_KEY || 'no-key';
    this.baseURL = hviskeBaseURL();
    this.client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseURL,
      // No SDK auto-retries: a retried batch re-uploads ~1 MB of WAV and triples the
      // worst-case lane occupancy under full fan-out. Retries happen at the
      // application level instead (see vad-batch-server.ts), where they run AFTER
      // the first wave drains rather than amplifying an overloaded server.
      maxRetries: 0,
    });
    this.model = hviskeModel();
    this.language = process.env.ASR_LANGUAGE ?? 'da';
  }

  // One-shot diarized transcription: POSTs the whole recording to the ensemble
  // endpoint with diarize=true + verbose_json and maps the response straight to
  // labelled, timed TranscriptSegment[]. No VAD batching, no separate diarization
  // pass — the server does both. Speaker is a 0-indexed integer → 'Taler N'.
  async transcribeEnsemble(audioBuffer: Buffer, mimeType: string): Promise<TranscriptSegment[]> {
    const ext = mimeTypeToExt(mimeType);
    const file = new File([new Uint8Array(audioBuffer)], `audio.${ext}`, { type: mimeType });
    const form = new FormData();
    form.append('file', file);
    form.append('model', this.model);
    form.append('language', this.language);
    form.append('response_format', 'verbose_json');
    form.append('diarize', 'true');
    form.append('temperature', '0');

    const res = await fetch(`${this.baseURL}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
      // Generous: a full-length meeting is one call here (the server fans out
      // internally), so this covers worst-case long recordings.
      signal: AbortSignal.timeout(600_000),
    });
    if (!res.ok) {
      throw new Error(`Transcription server returned ${res.status}`);
    }

    const data = (await res.json()) as { segments?: VerboseSegment[] };
    const segments = Array.isArray(data.segments) ? data.segments : [];
    return segments
      .map((seg): TranscriptSegment => ({
        // speaker is 0-indexed; speakerLabel is 1-indexed. Missing speaker (a
        // segment the diarizer couldn't place) falls back to the first speaker.
        speaker: typeof seg.speaker === 'number' ? speakerLabel(seg.speaker + 1) : DEFAULT_SPEAKER_LABEL,
        start: seg.start ?? 0,
        end: seg.end ?? seg.start ?? 0,
        text: (seg.text ?? '').trim(),
      }))
      .filter((s) => s.text.length > 0);
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
