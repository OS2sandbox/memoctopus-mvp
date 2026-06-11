/**
 * Roster participant filtering.
 *
 * teams.live.com lists non-human entries in the meeting roster — most notably
 * "Microsoft Teams meeting" (the meeting/organizer placeholder). Counting
 * these as participants keeps the bot from ever detecting it is alone, so it
 * never auto-leaves when the last human departs. We also strip the internal
 * "__audio_detected__" sentinel the capture code uses before any name is known.
 */

const SYSTEM_PARTICIPANT_NAMES = new Set<string>([
  'microsoft teams meeting',
  'microsoft teams',
  'teams meeting',
  'meeting',
  '__audio_detected__',
]);

/** True when `name` is a real human participant (not the bot, not a phantom). */
export function isRealParticipant(name: string, botName: string): boolean {
  const n = name.trim().toLowerCase();
  if (!n) return false;
  if (n === botName.trim().toLowerCase()) return false;
  return !SYSTEM_PARTICIPANT_NAMES.has(n);
}

/** Filter a roster name list down to real human participants. */
export function realParticipants(names: string[], botName: string): string[] {
  return names.filter((n) => isRealParticipant(n, botName));
}
