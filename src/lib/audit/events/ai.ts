// minutes.generate and export.download: what a person asked for. Pipeline steps
// (transcription, diarization, chapters, clarifications) are NOT audited. Counts,
// sizes and durations only; never the text that went in or came out, and never an
// error message (use outcomeCode).
import { z } from 'zod';
import { amount, code, count, defineEvent } from './types';

const outcomeCode = () => code().optional();

const meetingRef = {
  sources: ['server'] as const,
  entityType: 'meeting',
  entityIdRequired: false,
};

export const aiEvents = {
  'minutes.generate': defineEvent({
    ...meetingRef,
    // The first type is the default when a caller names none (personal templates).
    secondaryEntityTypes: ['template', 'central_template'],
    details: z
      .object({
        templateSource: z.enum(['personal', 'default', 'none', 'central']),
        // Which version of a central template produced the minutes; absent for other sources.
        templateVersion: count().min(1).optional(),
        durationMs: amount(),
        segmentCount: count(),
        outcomeCode: outcomeCode(),
      })
      .strict(),
  }),
  'export.download': defineEvent({
    ...meetingRef,
    details: z.object({ format: z.enum(['pdf', 'docx', 'md']) }).strict(),
  }),
} as const;
