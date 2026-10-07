// What a person asked the server to do with a meeting: audio.upload (audio sent
// for transcription, by the browser or by the bot service), minutes.generate and
// export.download. Pipeline steps (transcription, diarization, chapters,
// clarifications) are NOT audited as such: the upload is the action, the steps
// behind it are not. Counts, sizes, durations and booleans only; never the text that
// went in or came out, the instruction a person typed, a file name or an error
// message (use outcomeCode).
import { z } from 'zod';
import { amount, code, count, defineEvent } from './types';

const outcomeCode = () => code().optional();

const meetingRef = {
  sources: ['server'] as const,
  entityType: 'meeting',
  entityIdRequired: false,
};

export const aiEvents = {
  // Audio received by the server for transcription. `channel`: batch = recording
  // transcribed in batches, upload = a file upload, bot = the bot service handing in
  // a Teams recording (source 'system', authenticated by BOT_INTERNAL_SECRET).
  'audio.upload': defineEvent({
    sources: ['server', 'system'],
    entityType: 'meeting',
    entityIdRequired: false,
    details: z
      .object({
        channel: z.enum(['batch', 'upload', 'bot']),
        bytes: count(),
        durationMs: amount().optional(),
        outcomeCode: outcomeCode(),
      })
      .strict(),
  }),
  'minutes.generate': defineEvent({
    ...meetingRef,
    // The first type is the default when a caller names none (personal templates).
    secondaryEntityTypes: ['template', 'central_template'],
    details: z
      .object({
        templateSource: z.enum(['personal', 'default', 'none', 'central']),
        // Which version of a central template produced the minutes; absent for other sources.
        templateVersion: count().min(1).optional(),
        // Whether the person supplied an extra instruction. The text is never logged.
        userInstruction: z.boolean(),
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
