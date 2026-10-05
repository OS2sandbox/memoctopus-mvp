// Teams bot lifecycle. The entity is the meeting (client-generated uuid), never
// its title or URL. `bot.joined/ended/error` may arrive from the bot-service
// callback (source 'system', authenticated by BOT_INTERNAL_SECRET).
import { z } from 'zod';
import { amount, code, count, defineEvent } from './types';

const user = { sources: ['server'] as const, entityType: 'meeting', entityIdRequired: false };
// 'system' first: the bot-service callback is the normal producer, so it is the default source.
const callback = { sources: ['system', 'server'] as const, entityType: 'meeting', entityIdRequired: false };

export const botEvents = {
  'bot.session_start': defineEvent({ ...user, details: z.object({}).strict() }),
  'bot.session_pause': defineEvent({ ...user, details: z.object({}).strict() }),
  'bot.session_resume': defineEvent({ ...user, details: z.object({}).strict() }),
  'bot.session_stop': defineEvent({ ...user, details: z.object({ durationSeconds: amount().optional() }).strict() }),
  'bot.session_abort': defineEvent({ ...user, details: z.object({ reason: code().optional() }).strict() }),
  'bot.audio_collect': defineEvent({
    ...user,
    details: z.object({ bytes: count().optional(), durationMs: amount().optional() }).strict(),
  }),
  'bot.transcript_collect': defineEvent({
    ...user,
    details: z.object({ segmentCount: count().optional(), durationMs: amount().optional() }).strict(),
  }),
  'bot.joined': defineEvent({ ...callback, details: z.object({}).strict() }),
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
