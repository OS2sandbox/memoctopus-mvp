// Streaming downsampler that runs on the audio rendering thread.
// Receives 128-sample Float32 frames at the device's native rate, emits
// 1024-sample Int16 frames at 16 kHz over its message port. Box-average
// downsampling matches the previous main-thread implementation; for
// non-integer ratios we walk an integer boundary derived from the running
// output count to avoid drift.

const TARGET_RATE = 16000
const FRAME_OUT_SAMPLES = 1024 // ~64 ms @ 16 kHz

class ASRDownsampler extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ratio = sampleRate / TARGET_RATE
    this.srcConsumed = 0
    this.outEmitted = 0
    this.sum = 0
    this.count = 0
    this.frame = new Int16Array(FRAME_OUT_SAMPLES)
    this.frameIdx = 0
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0]
    if (!input) return true

    for (let i = 0; i < input.length; i++) {
      this.sum += input[i]
      this.count++
      this.srcConsumed++
      const boundary = Math.round((this.outEmitted + 1) * this.ratio)
      if (this.srcConsumed >= boundary) {
        const avg = this.count > 0 ? this.sum / this.count : 0
        const clamped = avg < -1 ? -1 : avg > 1 ? 1 : avg
        this.frame[this.frameIdx++] =
          clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
        this.sum = 0
        this.count = 0
        this.outEmitted++
        if (this.frameIdx === FRAME_OUT_SAMPLES) {
          const out = this.frame.buffer
          this.port.postMessage(out, [out])
          this.frame = new Int16Array(FRAME_OUT_SAMPLES)
          this.frameIdx = 0
        }
      }
    }
    return true
  }
}

registerProcessor('asr-downsampler', ASRDownsampler)
