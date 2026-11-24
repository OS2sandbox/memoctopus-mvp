import type { TranscriptSegment } from '@/types';

/**
 * The transcript as plain text for pasting elsewhere: one paragraph per speaker
 * turn (`Navn: tekst`, consecutive segments by one speaker joined), separated by
 * a blank line. Callers pass the segments as displayed, so masked PII stays masked.
 */
export function transcriptToText(segments: TranscriptSegment[]): string {
  const turns: { speaker: string; texts: string[] }[] = [];
  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text) continue;
    const last = turns[turns.length - 1];
    if (last && last.speaker === seg.speaker) last.texts.push(text);
    else turns.push({ speaker: seg.speaker, texts: [text] });
  }
  return turns.map((t) => `${t.speaker}: ${t.texts.join(' ')}`).join('\n\n');
}
