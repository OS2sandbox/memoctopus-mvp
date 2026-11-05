import { queryUserSchema, queryUserSchemaOne } from '@/lib/db/user-schema';
import { ONE_TIME_HINT_IDS } from './steps';

export type OnboardingStateRow = {
  tourSkipped: boolean;
  tourCompleted: boolean;
};

export type SeenStep = { stepId: string; meetingId: string | null };

export async function getOnboardingState(userId: string): Promise<OnboardingStateRow> {
  const row = await queryUserSchemaOne<{
    tour_skipped_at: string | null;
    tour_completed_at: string | null;
  }>(userId, `SELECT tour_skipped_at, tour_completed_at FROM onboarding_state WHERE id = 'singleton'`);

  return {
    tourSkipped: !!row?.tour_skipped_at,
    tourCompleted: !!row?.tour_completed_at,
  };
}

// '' stands for "global, not tied to a meeting" in the meeting_id column — see
// ensureUserSchema. Converted back to null here so the rest of the app only
// ever deals with the null it already expects.
function realMeetingId(dbValue: string): string | null {
  return dbValue === '' ? null : dbValue;
}

export async function getSeenSteps(userId: string): Promise<SeenStep[]> {
  const rows = await queryUserSchema<{ step_id: string; meeting_id: string }>(
    userId,
    `SELECT step_id, meeting_id FROM onboarding_progress`,
  );
  return rows.map((r) => ({ stepId: r.step_id, meetingId: realMeetingId(r.meeting_id) }));
}

export async function markStepSeen(userId: string, stepId: string, meetingId: string | null): Promise<void> {
  await queryUserSchema(
    userId,
    `INSERT INTO onboarding_progress (step_id, meeting_id, status)
     VALUES ($1, $2, 'seen')
     ON CONFLICT ON CONSTRAINT onboarding_progress_step_meeting_unique DO NOTHING`,
    [stepId, meetingId ?? ''],
  );
}

/**
 * "spring over": no hints at all, not just no welcome dialog. Marks every one-time
 * hint seen in the same statement as the skip flag (see resetHints for why one
 * statement). The "?" button replays them via resetHints.
 */
export async function skipTour(userId: string): Promise<void> {
  await queryUserSchema(
    userId,
    `WITH hints AS (
       INSERT INTO onboarding_progress (step_id, meeting_id, status)
       SELECT step_id, '', 'seen' FROM unnest($1::text[]) AS t(step_id)
       ON CONFLICT ON CONSTRAINT onboarding_progress_step_meeting_unique DO NOTHING
     )
     INSERT INTO onboarding_state (id, tour_skipped_at, updated_at)
     VALUES ('singleton', NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET tour_skipped_at = NOW(), updated_at = NOW()`,
    [ONE_TIME_HINT_IDS],
  );
}

/**
 * Replay: forget every seen hint so they all show again, and mark the tour
 * as completed so an empty progress table isn't mistaken for a first-time
 * user (which would re-open the welcome dialog on the next page load).
 */
export async function resetHints(userId: string): Promise<void> {
  // One statement (a data-modifying CTE always runs to completion, referenced or not), so
  // the delete and the state write commit together. Two separate queries would run on two
  // pooled connections, and a crash between them could leave an empty progress table with
  // no completed tour, which reads as a first-time user.
  await queryUserSchema(
    userId,
    `WITH cleared AS (DELETE FROM onboarding_progress)
     INSERT INTO onboarding_state (id, tour_completed_at, tour_skipped_at, updated_at)
     VALUES ('singleton', NOW(), NULL, NOW())
     ON CONFLICT (id) DO UPDATE SET tour_completed_at = NOW(), tour_skipped_at = NULL, updated_at = NOW()`,
  );
}
