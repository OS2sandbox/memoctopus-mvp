import { queryUserSchema, queryUserSchemaOne } from '@/lib/db/user-schema';

export type OnboardingStateRow = {
  tourSkipped: boolean;
  tourCompleted: boolean;
  lastStepId: string | null;
};

export type SeenStep = { stepId: string; meetingId: string | null };

export async function getOnboardingState(userId: string): Promise<OnboardingStateRow> {
  const row = await queryUserSchemaOne<{
    tour_skipped_at: string | null;
    tour_completed_at: string | null;
    last_step_id: string | null;
  }>(userId, `SELECT tour_skipped_at, tour_completed_at, last_step_id FROM onboarding_state WHERE id = 'singleton'`);

  return {
    tourSkipped: !!row?.tour_skipped_at,
    tourCompleted: !!row?.tour_completed_at,
    lastStepId: row?.last_step_id ?? null,
  };
}

export async function getSeenSteps(userId: string): Promise<SeenStep[]> {
  const rows = await queryUserSchema<{ step_id: string; meeting_id: string | null }>(
    userId,
    `SELECT step_id, meeting_id FROM onboarding_progress`,
  );
  return rows.map((r) => ({ stepId: r.step_id, meetingId: r.meeting_id }));
}

export async function markStepSeen(userId: string, stepId: string, meetingId: string | null): Promise<void> {
  // Plain UNIQUE(step_id, meeting_id) treats every NULL as distinct, so the
  // global (meeting_id IS NULL) case is deduped by its own partial index
  // instead — the two cases need separate ON CONFLICT targets.
  if (meetingId === null) {
    await queryUserSchema(
      userId,
      `INSERT INTO onboarding_progress (step_id, meeting_id, status)
       VALUES ($1, NULL, 'seen')
       ON CONFLICT (step_id) WHERE meeting_id IS NULL DO NOTHING`,
      [stepId],
    );
  } else {
    await queryUserSchema(
      userId,
      `INSERT INTO onboarding_progress (step_id, meeting_id, status)
       VALUES ($1, $2, 'seen')
       ON CONFLICT ON CONSTRAINT onboarding_progress_step_meeting_unique DO NOTHING`,
      [stepId, meetingId],
    );
  }
  await queryUserSchema(
    userId,
    `INSERT INTO onboarding_state (id, last_step_id, updated_at)
     VALUES ('singleton', $1, NOW())
     ON CONFLICT (id) DO UPDATE SET last_step_id = EXCLUDED.last_step_id, updated_at = NOW()`,
    [stepId],
  );
}

export async function skipTour(userId: string): Promise<void> {
  await queryUserSchema(
    userId,
    `INSERT INTO onboarding_state (id, tour_skipped_at, updated_at)
     VALUES ('singleton', NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET tour_skipped_at = NOW(), updated_at = NOW()`,
  );
}

export async function completeTour(userId: string): Promise<void> {
  await queryUserSchema(
    userId,
    `INSERT INTO onboarding_state (id, tour_completed_at, updated_at)
     VALUES ('singleton', NOW(), NOW())
     ON CONFLICT (id) DO UPDATE SET tour_completed_at = NOW(), updated_at = NOW()`,
  );
}

/**
 * Replay: forget every seen hint so they all show again, and mark the tour
 * as completed so an empty progress table isn't mistaken for a first-time
 * user (which would re-open the welcome dialog on the next page load).
 */
export async function resetHints(userId: string): Promise<void> {
  // One statement (a data-modifying CTE always runs to completion, referenced or not), so
  // the delete and the state write commit together and a concurrent markStepSeen cannot
  // land between them. Two separate queries would run on two pooled connections.
  await queryUserSchema(
    userId,
    `WITH cleared AS (DELETE FROM onboarding_progress)
     INSERT INTO onboarding_state (id, tour_completed_at, tour_skipped_at, last_step_id, updated_at)
     VALUES ('singleton', NOW(), NULL, NULL, NOW())
     ON CONFLICT (id) DO UPDATE SET tour_completed_at = NOW(), tour_skipped_at = NULL, last_step_id = NULL, updated_at = NOW()`,
  );
}
