// Browser-only audio utilities used by the VAD-based recording and upload flows.

// Simple energy-based VAD. Avoids onnxruntime-web entirely — no WASM, no
// dynamic module imports, no asset path issues in Next.js.
// Yields speech segments as Float32Array slices at the input sample rate,
// with start/end in seconds relative to the original audio timeline.
export function* energyVAD(
  audio: Float32Array,
  sampleRate: number,
): Generator<{ audio: Float32Array; start: number; end: number }> {
  const frameSamples   = Math.round(sampleRate * 0.03);   // 30ms per frame
  const threshold      = 0.01;                             // RMS speech threshold
  const prePad         = Math.round(sampleRate * 0.25);   // 250ms pre-roll
  const postPad        = Math.round(sampleRate * 0.40);   // 400ms post-roll
  const minSpeech      = Math.round(sampleRate * 0.10);   // 100ms min speech
  const minSilFrames   = Math.ceil(sampleRate * 0.80 / frameSamples); // 800ms silence to close

  const numFrames = Math.ceil(audio.length / frameSamples);
  const isSpeech: boolean[] = new Array(numFrames);
  for (let i = 0; i < numFrames; i++) {
    const s = i * frameSamples;
    const e = Math.min(s + frameSamples, audio.length);
    let sum = 0;
    for (let j = s; j < e; j++) sum += audio[j] * audio[j];
    isSpeech[i] = Math.sqrt(sum / (e - s)) >= threshold;
  }

  let segStart = -1;
  let silFrames = 0;

  for (let i = 0; i < numFrames; i++) {
    if (isSpeech[i]) {
      if (segStart === -1) segStart = i;
      silFrames = 0;
    } else if (segStart !== -1) {
      if (++silFrames >= minSilFrames) {
        const from = Math.max(0, segStart * frameSamples - prePad);
        const to   = Math.min(audio.length, (i - silFrames) * frameSamples + postPad);
        if (to - from >= minSpeech) {
          yield { audio: audio.slice(from, to), start: from / sampleRate, end: to / sampleRate };
        }
        segStart = -1;
        silFrames = 0;
      }
    }
  }

  if (segStart !== -1) {
    const from = Math.max(0, segStart * frameSamples - prePad);
    const to   = Math.min(audio.length, audio.length + postPad);
    if (to - from >= minSpeech) {
      yield { audio: audio.slice(from, to), start: from / sampleRate, end: to / sampleRate };
    }
  }
}
