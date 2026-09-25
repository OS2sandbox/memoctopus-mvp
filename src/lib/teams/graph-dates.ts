/**
 * Microsoft Graph does not omit a missing date on an onlineMeeting. It returns
 * the .NET zero value, `0001-01-01T00:00:00Z`, which is a perfectly parseable
 * timestamp roughly two thousand years in the past.
 *
 * That matters because an instant meeting — "Mød nu", started without a calendar
 * entry — has no schedule, so both startDateTime and endDateTime come back as the
 * sentinel. Stored as-is it makes every "has this meeting finished?" comparison
 * answer yes and every "have we waited long enough to give up?" comparison answer
 * yes too, so the meeting is abandoned before Graph is ever asked for artifacts.
 *
 * Anything before this cutoff is treated as absent. The callers already handle an
 * absent schedule: the poller falls back to when it was asked to watch the
 * meeting, and artifact selection drops the occurrence window and takes the
 * newest artifact, which is what an instant meeting wants.
 */
const EARLIEST_PLAUSIBLE_MS = Date.UTC(1990, 0, 1);

function isPlausible(ms: number): boolean {
  return Number.isFinite(ms) && ms >= EARLIEST_PLAUSIBLE_MS;
}

/** A Graph date string, or null when missing, unparseable or the zero sentinel. */
export function graphDate(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return isPlausible(Date.parse(value)) ? value : null;
}

/** A stored Date, or null when it is the zero sentinel a past release wrote. */
export function realDate(value: Date | null | undefined): Date | null {
  if (!value) return null;
  return isPlausible(value.getTime()) ? value : null;
}
