// Teams bot lifecycle. The entity is the meeting (client-generated uuid), never
// its title or URL. `bot.ended/error` may arrive from the bot-service
// callback (source 'system', authenticated by BOT_INTERNAL_SECRET). bot.audio_delete
// is the server deleting the recording it held for the browser (system action).
import { z } from 'zod';
import { amount, code, defineEvent } from './types';

const user = { sources: ['server'] as const, entityType: 'meeting', entityIdRequired: false };
// 'system' first: the bot-service callback is the normal producer, so it is the default source.
const callback = { sources: ['system', 'server'] as const, entityType: 'meeting', entityIdRequired: false };

export const botEvents = {
  'bot.session_start': defineEvent({ ...user, details: z.object({}).strict() }),
  'bot.session_pause': defineEvent({ ...user, details: z.object({}).strict() }),
  'bot.session_resume': defineEvent({ ...user, details: z.object({}).strict() }),
  'bot.session_stop': defineEvent({ ...user, details: z.object({}).strict() }),
  'bot.session_abort': defineEvent({ ...user, details: z.object({}).strict() }),
  // The server-held copy of a bot recording was deleted: handoff = the browser collected
  // it, ttl = nobody did and the retention sweep removed it. Automatic, so 'system' first.
  'bot.audio_delete': defineEvent({
    ...callback,
    details: z.object({ trigger: z.enum(['handoff', 'ttl']) }).strict(),
  }),
  'bot.ended': defineEvent({
    ...callback,
    details: z.object({ durationSeconds: amount().optional(), reason: code().optional() }).strict(),
  }),
  'bot.error': defineEvent({
    ...callback,
    defaultOutcome: 'error',
    details: z.object({ code: code() }).strict(),
  }),
} as const;
