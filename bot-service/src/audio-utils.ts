/**
 * Assembles raw WebM audio chunks from MediaRecorder into a single Buffer.
 *
 * The first chunk from MediaRecorder contains the WebM header (EBML + Segment).
 * Subsequent chunks are Cluster elements. Concatenating them directly produces a
 * valid (though seekless) WebM file suitable for batch transcription.
 */
export function assembleWebM(chunks: Buffer[]): Buffer {
  if (chunks.length === 0) return Buffer.alloc(0);
  return Buffer.concat(chunks);
}
