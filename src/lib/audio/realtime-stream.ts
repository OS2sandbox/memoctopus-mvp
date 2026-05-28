// Live transcription via ElevenLabs realtime Speech-to-Text (scribe_v2_realtime).
//
// This drives the live, low-latency text preview shown while the user is speaking.
// It does NOT produce the authoritative transcript: the realtime model is tuned for
// latency and does not do reliable diarization, so it streams text only. Speaker
// labels come later from the batch scribe_v2 pass (run at pause / final save).
//
// Flow: fetch a single-use token from our server → open the WS directly from the
// browser (no audio round-trips our backend) → capture mic PCM via an AudioWorklet,
// downsampled to 16 kHz by the AudioContext → stream base64 PCM16 chunks → surface
// partial (interim) and committed (stable) transcripts via callbacks.

const SAMPLE_RATE = 16_000;
const WS_BASE = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
const MAX_RECONNECT_ATTEMPTS = 5;

export interface RealtimeStreamCallbacks {
  /** Interim, still-changing text for the current utterance. */
  onPartial?: (text: string) => void;
  /** A stable, finalized chunk of text (committed by the server VAD). */
  onCommitted?: (text: string) => void;
  /** Non-fatal: live preview is degraded/unavailable, but recording continues. */
  onError?: (err: Error) => void;
}

export class RealtimeTranscriptionStream {
  private readonly meetingId: string;
  private readonly cb: RealtimeStreamCallbacks;

  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private ws: WebSocket | null = null;

  private stopped = true;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(meetingId: string, cb: RealtimeStreamCallbacks) {
    this.meetingId = meetingId;
    this.cb = cb;
  }

  /** Begin streaming. Reuses the caller's mic stream (no second getUserMedia). */
  async start(stream: MediaStream): Promise<void> {
    this.stopped = false;
    this.reconnectAttempts = 0;
    try {
      await this.setupAudio(stream);
    } catch (err) {
      this.cb.onError?.(asError(err));
      await this.stop();
      return;
    }
    await this.connect();
  }

  /** Tear down audio + socket. Safe to call multiple times. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = this.ws.onmessage = this.ws.onerror = this.ws.onclose = null;
      try { this.ws.close(); } catch { /* already closing */ }
      this.ws = null;
    }
    if (this.worklet) {
      this.worklet.port.onmessage = null;
      try { this.worklet.disconnect(); } catch { /* noop */ }
      this.worklet = null;
    }
    if (this.source) {
      try { this.source.disconnect(); } catch { /* noop */ }
      this.source = null;
    }
    if (this.ctx) {
      try { await this.ctx.close(); } catch { /* noop */ }
      this.ctx = null;
    }
  }

  private async setupAudio(stream: MediaStream): Promise<void> {
    // Requesting 16 kHz makes WebAudio resample the mic for us, so we can always
    // declare audio_format=pcm_16000 and keep the upstream bandwidth small.
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    await ctx.audioWorklet.addModule('/pcm-capture-worklet.js');
    const source = ctx.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(ctx, 'pcm-capture');
    worklet.port.onmessage = (e: MessageEvent) => this.sendAudio(e.data as Float32Array);
    source.connect(worklet);
    // Connect to destination so the graph is pulled; the worklet emits silence
    // (it never writes to its output), so nothing is echoed to the speakers.
    worklet.connect(ctx.destination);
    await ctx.resume();
    this.ctx = ctx;
    this.source = source;
    this.worklet = worklet;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;

    let token: string;
    try {
      const res = await fetch(`/api/meetings/${this.meetingId}/stream-token`, { method: 'POST' });
      if (!res.ok) throw new Error(`token request failed (${res.status})`);
      token = ((await res.json()) as { token: string }).token;
    } catch (err) {
      this.cb.onError?.(asError(err));
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;

    const url =
      `${WS_BASE}?token=${encodeURIComponent(token)}` +
      `&model_id=scribe_v2_realtime&language_code=da` +
      `&audio_format=pcm_${SAMPLE_RATE}&commit_strategy=vad`;

    const ws = new WebSocket(url);
    ws.onopen = () => { this.reconnectAttempts = 0; };
    ws.onmessage = (e) => this.handleMessage(e);
    ws.onerror = () => { /* a close event follows; reconnection is handled there */ };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (!this.stopped) this.scheduleReconnect();
    };
    this.ws = ws;
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.cb.onError?.(new Error('Live transcription connection lost'));
      return;
    }
    const delay = Math.min(8_000, 500 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => { void this.connect(); }, delay);
  }

  private sendAudio(frame: Float32Array): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const audioBase64 = base64FromBytes(floatTo16BitPCM(frame));
    ws.send(JSON.stringify({
      message_type: 'input_audio_chunk',
      audio_base_64: audioBase64,
      commit: false,
      sample_rate: SAMPLE_RATE,
    }));
  }

  private handleMessage(e: MessageEvent): void {
    let msg: { message_type?: string; text?: string; error_message?: string };
    try {
      msg = JSON.parse(e.data as string);
    } catch {
      return;
    }
    switch (msg.message_type) {
      case 'partial_transcript':
        if (typeof msg.text === 'string') this.cb.onPartial?.(msg.text);
        break;
      case 'committed_transcript':
      case 'committed_transcript_with_timestamps':
        if (typeof msg.text === 'string' && msg.text.trim()) this.cb.onCommitted?.(msg.text.trim());
        break;
      case 'error':
      case 'auth_error':
      case 'quota_exceeded':
      case 'rate_limited':
        this.cb.onError?.(new Error(msg.error_message ?? msg.message_type));
        break;
      default:
        break;
    }
  }
}

function floatTo16BitPCM(input: Float32Array): Uint8Array {
  const out = new Uint8Array(input.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, s * 0x7fff, true);
  }
  return out;
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
