import { z } from 'zod';

const uuid = z.string().uuid();

// Meetings are client-generated ids; only a real UUID may be stored as an audit
// entity. Anything else is left out so the event still records the activity.
export function meetingEntity(meetingId: string): { entityId?: string } {
  return uuid.safeParse(meetingId).success ? { entityId: meetingId } : {};
}
