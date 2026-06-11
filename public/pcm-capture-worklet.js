// AudioWorklet that forwards captured microphone audio (mono Float32 PCM) to the
// main thread. Used to feed the ElevenLabs realtime speech-to-text WebSocket.
//
// process() is called with 128-sample render quanta. Posting every quantum (~125
// msgs/sec at 16 kHz) is wasteful, so we accumulate into a larger buffer and flush
// in chunks of FRAME_SIZE samples (~64 ms at the 16 kHz capture rate we use).

const FRAME_SIZE = 1024;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(FRAME_SIZE);
    this._offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    // No input connected (or stream ended) — keep the processor alive.
    if (!input || input.length === 0) return true;

    const channel = input[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this._buffer[this._offset++] = channel[i];
      if (this._offset === FRAME_SIZE) {
        // Transfer a copy so the underlying buffer can be reused immediately.
        const frame = this._buffer.slice(0, FRAME_SIZE);
        this.port.postMessage(frame, [frame.buffer]);
        this._offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
