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

// Decode, downmix to mono, and resample to 16 kHz — all in 60-second chunks.
// A single OfflineAudioContext for a 74-minute file would be ~71M frames, which
// browsers silently truncate around the 10M-frame mark. Processing in small
// chunks keeps each OfflineAudioContext well within browser limits.
export async function decodeAndResampleTo16k(arrayBuffer: ArrayBuffer): Promise<Float32Array> {
  const audioCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await audioCtx.decodeAudioData(arrayBuffer);
  } finally {
    await audioCtx.close();
  }

  if (decoded.numberOfChannels < 1) {
    throw new Error('Audio file has no channels');
  }

  // Fast path: already at 16 kHz mono — no resampling or copy needed.
  if (decoded.sampleRate === 16_000 && decoded.numberOfChannels === 1) {
    return decoded.getChannelData(0).slice();
  }

  const fromRate = decoded.sampleRate;
  const CHUNK_S = 60;
  const chunkInputFrames = Math.round(fromRate * CHUNK_S);
  const totalInputFrames = decoded.length;
  const outputChunks: Float32Array[] = [];

  for (let offset = 0; offset < totalInputFrames; offset += chunkInputFrames) {
    const end = Math.min(offset + chunkInputFrames, totalInputFrames);
    const chunkLength = end - offset;
    const outLength = Math.ceil(chunkLength * 16_000 / fromRate);

    const offCtx = new OfflineAudioContext({ numberOfChannels: 1, length: outLength, sampleRate: 16_000 });
    const srcBuf = offCtx.createBuffer(1, chunkLength, fromRate);
    const srcData = srcBuf.getChannelData(0);

    // Downmix channels into the mono source buffer for this chunk.
    if (decoded.numberOfChannels === 1) {
      srcData.set(decoded.getChannelData(0).subarray(offset, end));
    } else {
      const scale = 1 / decoded.numberOfChannels;
      for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
        const chData = decoded.getChannelData(ch).subarray(offset, end);
        for (let i = 0; i < chunkLength; i++) srcData[i] += chData[i] * scale;
      }
    }

    const src = offCtx.createBufferSource();
    src.buffer = srcBuf;
    src.connect(offCtx.destination);
    src.start();
    const out = await offCtx.startRendering();
    outputChunks.push(out.getChannelData(0).slice());
  }

  const totalLength = outputChunks.reduce((s, c) => s + c.length, 0);
  const result = new Float32Array(totalLength);
  let off = 0;
  for (const chunk of outputChunks) { result.set(chunk, off); off += chunk.length; }
  return result;
}
