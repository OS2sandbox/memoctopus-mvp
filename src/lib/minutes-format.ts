import type { MinutesContent } from '@/types';

/**
 * Flatten a referat into a single markdown document.
 *
 * New minutes carry a `body` string directly. Older minutes only have the
 * legacy `sections[]` shape — those are joined into one document (each section
 * label becomes a `##` heading) so they render in the single-surface editor and
 * export unchanged.
 */
export function minutesToBody(content: MinutesContent | null | undefined): string {
  if (!content) return '';
  if (typeof content.body === 'string') return content.body;
  const sections = content.sections ?? [];
  return sections
    .filter((s) => (s.content ?? '').trim().length > 0)
    .map((s) => `## ${s.label}\n\n${s.content.trim()}`)
    .join('\n\n')
    .trim();
}
