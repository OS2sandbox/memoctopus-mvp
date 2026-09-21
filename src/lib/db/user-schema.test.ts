import { describe, it, expect, vi, beforeEach } from 'vitest';

const queries: string[] = [];
const client = {
  query: vi.fn(async (sql: string) => {
    queries.push(sql);
    return { rows: [], rowCount: 0 };
  }),
  release: vi.fn(),
};

vi.mock('./index', () => ({
  pool: { connect: vi.fn(async () => client) },
}));

import { ensureUserSchema } from './user-schema';

beforeEach(() => {
  queries.length = 0;
  client.query.mockClear();
});

describe('ensureUserSchema — onboarding_progress', () => {
  it('does not tie meeting_id to the server-side meetings table', async () => {
    // Meetings live in the browser's IndexedDB; nothing ever inserts into the per-user
    // meetings table, so a foreign key there rejects every per-meeting hint.
    await ensureUserSchema('11111111-1111-1111-1111-111111111111');

    const create = queries.find((q) => /CREATE TABLE IF NOT EXISTS\s+"[^"]+"\.onboarding_progress\s*\(/.test(q));
    expect(create).toBeDefined();
    expect(create).not.toMatch(/REFERENCES/i);
  });

  it('drops the foreign key from databases that already created the table with it', async () => {
    await ensureUserSchema('22222222-2222-2222-2222-222222222222');

    expect(
      queries.some((q) =>
        /ALTER TABLE\s+"[^"]+"\.onboarding_progress\s+DROP CONSTRAINT IF EXISTS\s+onboarding_progress_meeting_id_fkey/i.test(q),
      ),
    ).toBe(true);
  });
});
