import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/user-schema', () => ({
  queryUserSchema: vi.fn(),
  queryUserSchemaOne: vi.fn(),
}));

import { getMeetingPageData, resolveInitialTab } from './meeting-page';
import { queryUserSchema, queryUserSchemaOne } from '@/lib/db/user-schema';

const mockQueryOne = vi.mocked(queryUserSchemaOne);
const mockQueryMany = vi.mocked(queryUserSchema);

const MEETING = { id: 'meet-1', status: 'review', title: 'Testmøde' };
const AUDIO_ROW = { duration_seconds: 300, size_bytes: 1024 * 1024 };
const TRANSCRIPT_ROW = {
  id: 'transcript-1',
  raw_text: 'Hej verden.',
  segments: [{ speaker: 'Taler 1', start: 0, end: 5, text: 'Hej verden.' }],
  pii_removed_at: null,
  pii_replacements: [],
};
const CHAPTERS_ROW = {
  chapters: [
    { id: 'ch-0', title: 'Åbning', summary: 'S', startTime: 0, endTime: 5, segmentIndices: [0] },
  ],
};
const MINUTES_ROW = {
  id: 'min-1',
  content: { sections: [{ key: 'resumé', label: 'Resumé', content: 'Kort.' }] },
  version: 1,
  created_at: '2026-01-01T00:00:00Z',
};

// ─── getMeetingPageData ───────────────────────────────────────────────────────

describe('getMeetingPageData', () => {
  beforeEach(() => {
    mockQueryOne.mockReset();
    mockQueryMany.mockReset();
    // ALTER TABLE migration (ensureColumns — always succeeds)
    mockQueryMany.mockResolvedValue([]);
  });

  it('returns null when meeting is not found', async () => {
    mockQueryOne.mockResolvedValueOnce(null); // meeting SELECT

    const result = await getMeetingPageData('user-1', 'missing-id');
    expect(result).toBeNull();
  });

  it('returns meeting with correct fields', async () => {
    mockQueryOne.mockResolvedValueOnce(MEETING as never); // meeting
    mockQueryOne.mockResolvedValueOnce(AUDIO_ROW as never); // audio_files
    mockQueryOne.mockResolvedValueOnce(TRANSCRIPT_ROW as never); // transcripts
    mockQueryOne.mockResolvedValueOnce(CHAPTERS_ROW as never); // chapters
    mockQueryMany.mockResolvedValueOnce([]); // minute_versions (but minutes query returns null)
    mockQueryOne.mockResolvedValueOnce(null as never); // minutes SELECT

    const result = await getMeetingPageData('user-1', 'meet-1');

    expect(result?.meeting.id).toBe('meet-1');
    expect(result?.meeting.status).toBe('review');
    expect(result?.meeting.title).toBe('Testmøde');
  });

  it('returns audioFile when audio exists', async () => {
    mockQueryOne.mockResolvedValueOnce(MEETING as never);
    mockQueryOne.mockResolvedValueOnce(AUDIO_ROW as never);
    mockQueryOne.mockResolvedValueOnce(TRANSCRIPT_ROW as never);
    mockQueryOne.mockResolvedValueOnce(CHAPTERS_ROW as never);
    mockQueryOne.mockResolvedValueOnce(null as never); // minutes

    const result = await getMeetingPageData('user-1', 'meet-1');

    expect(result?.audioFile).not.toBeNull();
    expect(result?.audioFile?.durationSeconds).toBe(300);
    expect(result?.audioFile?.sizeBytes).toBe(1024 * 1024);
  });

  it('returns audioFile as null when no audio exists', async () => {
    mockQueryOne.mockResolvedValueOnce(MEETING as never);
    mockQueryOne.mockResolvedValueOnce(null as never); // no audio
    mockQueryOne.mockResolvedValueOnce(TRANSCRIPT_ROW as never);
    mockQueryOne.mockResolvedValueOnce(CHAPTERS_ROW as never);
    mockQueryOne.mockResolvedValueOnce(null as never); // minutes

    const result = await getMeetingPageData('user-1', 'meet-1');
    expect(result?.audioFile).toBeNull();
  });

  it('returns transcript with parsed segments', async () => {
    mockQueryOne.mockResolvedValueOnce(MEETING as never);
    mockQueryOne.mockResolvedValueOnce(AUDIO_ROW as never);
    mockQueryOne.mockResolvedValueOnce(TRANSCRIPT_ROW as never);
    mockQueryOne.mockResolvedValueOnce(CHAPTERS_ROW as never);
    mockQueryOne.mockResolvedValueOnce(null as never); // minutes

    const result = await getMeetingPageData('user-1', 'meet-1');

    expect(result?.transcript?.segments).toHaveLength(1);
    expect(result?.transcript?.segments[0].speaker).toBe('Taler 1');
  });

  it('returns transcript as null when no transcript exists', async () => {
    mockQueryOne.mockResolvedValueOnce(MEETING as never);
    mockQueryOne.mockResolvedValueOnce(null as never); // no audio
    mockQueryOne.mockResolvedValueOnce(null as never); // no transcript

    const result = await getMeetingPageData('user-1', 'meet-1');
    expect(result?.transcript).toBeNull();
  });

  it('returns chapters from the DB when present', async () => {
    mockQueryOne.mockResolvedValueOnce(MEETING as never);
    mockQueryOne.mockResolvedValueOnce(AUDIO_ROW as never);
    mockQueryOne.mockResolvedValueOnce(TRANSCRIPT_ROW as never);
    mockQueryOne.mockResolvedValueOnce(CHAPTERS_ROW as never);
    mockQueryOne.mockResolvedValueOnce(null as never); // minutes

    const result = await getMeetingPageData('user-1', 'meet-1');
    expect(result?.transcript?.chapters).toHaveLength(1);
    expect(result?.transcript?.chapters[0].title).toBe('Åbning');
  });

  it('returns empty chapters array when chapters column fails', async () => {
    mockQueryOne.mockResolvedValueOnce(MEETING as never);
    mockQueryOne.mockResolvedValueOnce(AUDIO_ROW as never);
    mockQueryOne.mockResolvedValueOnce(TRANSCRIPT_ROW as never);
    mockQueryOne.mockRejectedValueOnce(new Error('column does not exist') as never);
    mockQueryOne.mockResolvedValueOnce(null as never); // minutes

    const result = await getMeetingPageData('user-1', 'meet-1');
    expect(result?.transcript?.chapters).toEqual([]);
  });

  it('returns minutes when they exist', async () => {
    mockQueryOne.mockResolvedValueOnce(MEETING as never);
    mockQueryOne.mockResolvedValueOnce(AUDIO_ROW as never);
    mockQueryOne.mockResolvedValueOnce(TRANSCRIPT_ROW as never);
    mockQueryOne.mockResolvedValueOnce(CHAPTERS_ROW as never);
    mockQueryOne.mockResolvedValueOnce(MINUTES_ROW as never);
    mockQueryMany.mockResolvedValueOnce([]); // minute_versions

    const result = await getMeetingPageData('user-1', 'meet-1');

    expect(result?.minutes?.id).toBe('min-1');
    expect(result?.minutes?.version).toBe(1);
    expect(result?.minutes?.content.sections).toHaveLength(1);
  });

  it('returns minutes as null when no minutes exist', async () => {
    mockQueryOne.mockResolvedValueOnce(MEETING as never);
    mockQueryOne.mockResolvedValueOnce(AUDIO_ROW as never);
    mockQueryOne.mockResolvedValueOnce(TRANSCRIPT_ROW as never);
    mockQueryOne.mockResolvedValueOnce(CHAPTERS_ROW as never);
    mockQueryOne.mockResolvedValueOnce(null as never); // no minutes

    const result = await getMeetingPageData('user-1', 'meet-1');
    expect(result?.minutes).toBeNull();
  });

  it('returns version history when versions exist', async () => {
    const versionRows = [
      { id: 'v-1', content: { sections: [] }, created_at: '2026-01-01T10:00:00Z' },
      { id: 'v-2', content: { sections: [] }, created_at: '2026-01-01T11:00:00Z' },
    ];

    mockQueryOne.mockResolvedValueOnce(MEETING as never);
    mockQueryOne.mockResolvedValueOnce(AUDIO_ROW as never);
    mockQueryOne.mockResolvedValueOnce(TRANSCRIPT_ROW as never);
    mockQueryOne.mockResolvedValueOnce(CHAPTERS_ROW as never);
    mockQueryOne.mockResolvedValueOnce(MINUTES_ROW as never);
    mockQueryMany.mockResolvedValueOnce(versionRows as never);

    const result = await getMeetingPageData('user-1', 'meet-1');
    expect(result?.minutes?.versions).toHaveLength(2);
  });

  it('returns empty array for segments when transcript segments are not an array', async () => {
    const transcriptWithBadSegments = { ...TRANSCRIPT_ROW, segments: null };

    mockQueryOne.mockResolvedValueOnce(MEETING as never);
    mockQueryOne.mockResolvedValueOnce(null as never); // no audio
    mockQueryOne.mockResolvedValueOnce(transcriptWithBadSegments as never);
    mockQueryOne.mockResolvedValueOnce(null as never); // chapters
    mockQueryOne.mockResolvedValueOnce(null as never); // no minutes

    const result = await getMeetingPageData('user-1', 'meet-1');
    expect(result?.transcript?.segments).toEqual([]);
  });

  it('uses the userId when querying the database', async () => {
    mockQueryOne.mockResolvedValueOnce(null as never);

    await getMeetingPageData('specific-user-id', 'meet-1');

    expect(mockQueryOne).toHaveBeenCalledWith(
      'specific-user-id',
      expect.any(String),
      expect.any(Array),
    );
  });

  it('does not cache migration as done when ensureColumns fails, and logs an error', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const migrationError = new Error('migration failed');

    // First call: ALTER TABLE fails — user must NOT be cached
    mockQueryMany.mockRejectedValueOnce(migrationError as never);
    mockQueryOne.mockResolvedValueOnce(null as never); // meeting SELECT returns null (no further calls)

    await getMeetingPageData('never-cached-user', 'meet-1');

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('[meeting-page] ensureColumns failed'),
      'never-cached-user',
      migrationError,
    );

    // Second call: migration should be retried since user was NOT cached on failure
    mockQueryMany.mockResolvedValueOnce([]); // ALTER TABLE succeeds this time
    mockQueryOne.mockResolvedValueOnce(null as never); // meeting SELECT

    await getMeetingPageData('never-cached-user', 'meet-1');

    // ALTER TABLE was called a second time (two total calls for this user)
    expect(mockQueryMany).toHaveBeenCalledTimes(2);

    consoleError.mockRestore();
  });

  it('logs an error for unexpected chapters column errors (not PG 42703)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unexpectedError = Object.assign(new Error('permission denied'), { code: '42501' });

    mockQueryOne.mockResolvedValueOnce(MEETING as never);
    mockQueryOne.mockResolvedValueOnce(AUDIO_ROW as never);
    mockQueryOne.mockResolvedValueOnce(TRANSCRIPT_ROW as never);
    mockQueryOne.mockRejectedValueOnce(unexpectedError as never); // chapters SELECT fails
    mockQueryOne.mockResolvedValueOnce(null as never); // minutes

    const result = await getMeetingPageData('user-1', 'meet-1');

    expect(result?.transcript?.chapters).toEqual([]);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('[meeting-page] unexpected error loading chapters column'),
      unexpectedError,
    );

    consoleError.mockRestore();
  });

  it('does not log an error for PG 42703 (expected missing column)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const missingColumnError = Object.assign(new Error('column "chapters" does not exist'), {
      code: '42703',
    });

    mockQueryOne.mockResolvedValueOnce(MEETING as never);
    mockQueryOne.mockResolvedValueOnce(AUDIO_ROW as never);
    mockQueryOne.mockResolvedValueOnce(TRANSCRIPT_ROW as never);
    mockQueryOne.mockRejectedValueOnce(missingColumnError as never); // chapters SELECT fails with 42703
    mockQueryOne.mockResolvedValueOnce(null as never); // minutes

    const result = await getMeetingPageData('user-1', 'meet-1');

    expect(result?.transcript?.chapters).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();

    consoleError.mockRestore();
  });
});

// ─── resolveInitialTab ────────────────────────────────────────────────────────

describe('resolveInitialTab', () => {
  it.each([
    ['minutes', 'minutes'],
    ['done', 'minutes'],
  ] as const)('returns "minutes" for status "%s"', (status, expected) => {
    expect(resolveInitialTab(status)).toBe(expected);
  });

  it('returns "review" for status "review"', () => {
    expect(resolveInitialTab('review')).toBe('review');
  });

  it.each(['recording', 'processing', 'unknown', ''] as const)(
    'returns "recording" for status "%s"',
    (status) => {
      expect(resolveInitialTab(status)).toBe('recording');
    },
  );
});
