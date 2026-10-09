import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/db/user-schema', () => ({
  queryUserSchema: vi.fn().mockResolvedValue([]),
  queryUserSchemaOne: vi.fn().mockResolvedValue(null),
}));

import { queryUserSchema, queryUserSchemaOne } from '@/lib/db/user-schema';
import {
  PARKED_TTL_DAYS,
  deleteParkedTranscript,
  hasParkedTranscript,
  open,
  parkTranscript,
  readParkedTranscript,
  seal,
  sweepParkedTranscripts,
} from './parked-transcripts';

const mockQuery = vi.mocked(queryUserSchema);
const mockQueryOne = vi.mocked(queryUserSchemaOne);

const TRANSCRIPT = {
  segments: [{ start: 0, end: 4, text: 'Velkommen til mødet.', speaker: 'Mette Hansen' }],
  diarized: true,
  participants: ['Mette Hansen'],
  durationSeconds: 1800,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockQuery.mockResolvedValue([]);
  mockQueryOne.mockResolvedValue(null);
  process.env.BETTER_AUTH_SECRET = 'test-secret-test-secret-test-secret';
});

afterEach(() => {
  delete process.env.BETTER_AUTH_SECRET;
});

describe('seal / open', () => {
  it('round-trips, Danish letters included', () => {
    expect(open(seal('Æbler, øl og år'))).toBe('Æbler, øl og år');
  });

  it('never stores the text in the clear', () => {
    const sealed = seal('Velkommen til mødet.');
    expect(sealed).not.toContain('Velkommen');
    expect(Buffer.from(sealed.split('.')[3], 'base64').toString('utf8')).not.toContain('Velkommen');
  });

  it('seals the same text differently each time', () => {
    expect(seal('samme')).not.toBe(seal('samme'));
  });

  it('refuses a payload that has been tampered with', () => {
    const [format, iv, tag, body] = seal('referat').split('.');
    const flipped = Buffer.from(body, 'base64');
    flipped[0] ^= 1;
    expect(() => open([format, iv, tag, flipped.toString('base64')].join('.'))).toThrow();
  });

  it('cannot be opened under another secret', () => {
    const sealed = seal('referat');
    process.env.BETTER_AUTH_SECRET = 'another-secret-another-secret-another';
    expect(() => open(sealed)).toThrow();
  });

  it('refuses to store anything when there is no secret to encrypt with', () => {
    delete process.env.BETTER_AUTH_SECRET;
    expect(() => seal('referat')).toThrow(/BETTER_AUTH_SECRET/);
  });
});

describe('parkTranscript', () => {
  it('upserts an encrypted payload into the owner\'s schema', async () => {
    await parkTranscript('u1', 'm1', TRANSCRIPT);

    const [userId, sql, params] = mockQuery.mock.calls[0];
    expect(userId).toBe('u1');
    expect(sql).toMatch(/INSERT INTO parked_transcripts/);
    expect(sql).toMatch(/ON CONFLICT \(meeting_id\) DO UPDATE/);
    expect(params![0]).toBe('m1');
    expect(String(params![1])).not.toContain('Velkommen');
    expect(JSON.parse(open(String(params![1])))).toEqual(TRANSCRIPT);
  });
});

describe('readParkedTranscript', () => {
  it('returns null when nothing is parked', async () => {
    expect(await readParkedTranscript('u1', 'm1')).toBeNull();
  });

  it('decrypts what was parked', async () => {
    mockQueryOne.mockResolvedValueOnce({ payload: seal(JSON.stringify(TRANSCRIPT)) });

    expect(await readParkedTranscript('u1', 'm1')).toEqual(TRANSCRIPT);
    expect(mockQueryOne.mock.calls[0][0]).toBe('u1');
    expect(mockQueryOne.mock.calls[0][2]).toEqual(['m1']);
  });

  it('reads a row it cannot decrypt as nothing, instead of failing every poll', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockQueryOne.mockResolvedValueOnce({ payload: 'v1.not.real.data' });

    expect(await readParkedTranscript('u1', 'm1')).toBeNull();
    error.mockRestore();
  });
});

describe('hasParkedTranscript / deleteParkedTranscript / sweepParkedTranscripts', () => {
  it('reports presence without reading the payload', async () => {
    expect(await hasParkedTranscript('u1', 'm1')).toBe(false);
    mockQueryOne.mockResolvedValueOnce({ '?column?': 1 });
    expect(await hasParkedTranscript('u1', 'm1')).toBe(true);
    expect(mockQueryOne.mock.calls[0][1]).not.toMatch(/payload/);
  });

  it('deletes one meeting\'s row in the caller\'s schema', async () => {
    await deleteParkedTranscript('u1', 'm1');

    const [userId, sql, params] = mockQuery.mock.calls[0];
    expect(userId).toBe('u1');
    expect(sql).toMatch(/DELETE FROM parked_transcripts WHERE meeting_id = \$1/);
    expect(params).toEqual(['m1']);
  });

  it('expires rows older than the retention period', async () => {
    await sweepParkedTranscripts('u1');

    const [, sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM parked_transcripts WHERE created_at < NOW\(\)/);
    expect(params).toEqual([PARKED_TTL_DAYS]);
    expect(PARKED_TTL_DAYS).toBe(30);
  });
});
