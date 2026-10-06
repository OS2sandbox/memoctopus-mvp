// AI/STT pipeline calls: counts, sizes and durations only. Never the text that
// went in or came out, and never an error message (use outcomeCode).
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
  'transcription.request': defineEvent({
    ...meetingRef,
    details: z
      .object({
        mode: z.enum(['live', 'batch', 'upload']),
        audioSeconds: amount().optional(),
        bytes: count().optional(),
        durationMs: amount(),
        outcomeCode: outcomeCode(),
      })
      .strict(),
  }),
  'diarization.request': defineEvent({
    ...meetingRef,
    details: z
      .object({
        audioSeconds: amount().optional(),
        speakerCount: count().optional(),
        durationMs: amount(),
        outcomeCode: outcomeCode(),
      })
      .strict(),
  }),
  'chapters.request': defineEvent({
    ...meetingRef,
    details: z
      .object({
        segmentCount: count().optional(),
        chapterCount: count().optional(),
        durationMs: amount(),
        outcomeCode: outcomeCode(),
      })
      .strict(),
  }),
  'clarifications.request': defineEvent({
    ...meetingRef,
    details: z
      .object({
        segmentCount: count().optional(),
        questionCount: count().optional(),
        durationMs: amount(),
        outcomeCode: outcomeCode(),
      })
      .strict(),
  }),
  'export.download': defineEvent({
    ...meetingRef,
    details: z.object({ format: z.enum(['pdf', 'docx', 'md']) }).strict(),
  }),
} as const;
