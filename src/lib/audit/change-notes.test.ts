import { describe, it, expect, vi } from 'vitest';
vi.mock('@/lib/db', () => ({ pool: { query: vi.fn() }, db: {} }));
import { changeNotesFor } from './change-notes';
import type { AuditEventRow } from './query';

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';

const row = (over: Partial<AuditEventRow>): AuditEventRow => ({
  id: '1',
  occurredAt: new Date(),
  source: 'server',
  eventType: 'central_template.update',
  outcome: 'success',
  actorUserId: 'u',
  actorName: 'A',
  actorOrgUnitUuid: null,
  entityType: 'central_template',
  entityId: T1,
  secondaryEntityType: null,
  secondaryEntityId: null,
  ipAddress: null,
  userAgent: null,
  requestId: null,
  details: { version: 2 },
  clientOccurredAt: null,
  ...over,
});

describe('changeNotesFor', () => {
  it('looks the notes up by (template, version) in ONE query and keys them by audit row id', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        { template_id: T1, version: 2, change_note: 'Præciserer tonen.', template_name: 'Referat' },
        { template_id: T2, version: 1, change_note: 'Første version.', template_name: null },
      ],
    });
    const notes = await changeNotesFor(
      [row({ id: '10' }), row({ id: '11', entityId: T2, eventType: 'central_template.create', details: { version: 1 } })],
      { query },
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual([[T1, T2], [2, 1]]);
    expect(notes.get('10')).toEqual({ changeNote: 'Præciserer tonen.', templateName: 'Referat' });
    expect(notes.get('11')).toEqual({ changeNote: 'Første version.', templateName: null });
  });

  it('does not query for rows without a change: legacy rows of removed types (central_template.read), other types, bad ids or versions', async () => {
    const query = vi.fn();
    const notes = await changeNotesFor(
      [
        row({ id: '1', eventType: 'central_template.read' }),
        row({ id: '2', eventType: 'export.download' }),
        row({ id: '3', entityId: 'not-a-uuid' }),
        row({ id: '4', entityId: null }),
        row({ id: '5', details: { version: 0 } }),
        row({ id: '6', details: { version: '2' } }),
        row({ id: '7', details: {} }),
      ],
      { query },
    );
    expect(query).not.toHaveBeenCalled();
    expect(notes.size).toBe(0);
  });

  it('omits a row whose version is gone (no note, no crash)', async () => {
    const notes = await changeNotesFor([row({ id: '9' })], { query: vi.fn().mockResolvedValue({ rows: [] }) });
    expect(notes.has('9')).toBe(false);
  });

  describe('personal template notes', () => {
    const P1 = '33333333-3333-4333-8333-333333333333';
    const P2 = '44444444-4444-4444-8444-444444444444';
    const personalRow = (over: Partial<AuditEventRow>) =>
      row({ eventType: 'template.update', entityType: 'template', actorUserId: 'user-a', entityId: P1, details: { changedFields: ['prompt'], hasChangeNote: true, version: 3 }, ...over });

    it('looks a personal note up per actor, in that person\'s own history, and keys it by audit row id', async () => {
      const query = vi.fn();
      const personal = vi.fn().mockImplementation(async (userId: string) =>
        userId === 'user-a' ? [{ skabelon_id: P1, version: 3, change_note: 'Gjorde tonen mere formel.' }] : [{ skabelon_id: P2, version: 1, change_note: 'Første udgave.' }],
      );
      const notes = await changeNotesFor(
        [personalRow({ id: '20' }), personalRow({ id: '21', actorUserId: 'user-b', entityId: P2, details: { changedFields: ['name'], hasChangeNote: true, version: 1 } })],
        { query, personal },
      );
      expect(query).not.toHaveBeenCalled(); // no central rows
      expect(personal).toHaveBeenCalledTimes(2);
      expect(personal).toHaveBeenCalledWith('user-a', [P1], [3]);
      expect(personal).toHaveBeenCalledWith('user-b', [P2], [1]);
      expect(notes.get('20')).toEqual({ changeNote: 'Gjorde tonen mere formel.', templateName: null });
      expect(notes.get('21')).toEqual({ changeNote: 'Første udgave.', templateName: null });
    });

    it('does not look up edits without a note, without a version (older events), without an actor, or with a bad id', async () => {
      const query = vi.fn();
      const personal = vi.fn();
      const notes = await changeNotesFor(
        [
          personalRow({ id: '1', details: { changedFields: ['prompt'], hasChangeNote: false, version: 3 } }),
          personalRow({ id: '2', details: { changedFields: ['prompt'], hasChangeNote: true } }),
          personalRow({ id: '3', actorUserId: null }),
          personalRow({ id: '4', entityId: 'not-a-uuid' }),
          personalRow({ id: '5', eventType: 'template.delete', details: {} }),
        ],
        { query, personal },
      );
      expect(personal).not.toHaveBeenCalled();
      expect(notes.size).toBe(0);
    });

    it('ignores a version the person no longer has, and a row that is not a string note', async () => {
      const personal = vi.fn().mockResolvedValue([{ skabelon_id: P1, version: 9, change_note: 'Anden version.' }, { skabelon_id: P1, version: 3, change_note: null }]);
      const notes = await changeNotesFor([personalRow({ id: '30' })], { query: vi.fn(), personal });
      expect(notes.size).toBe(0);
    });

    it('does the central lookup and the personal lookup side by side', async () => {
      const query = vi.fn().mockResolvedValue({ rows: [{ template_id: T1, version: 2, change_note: 'Præciserer tonen.', template_name: 'Referat' }] });
      const personal = vi.fn().mockResolvedValue([{ skabelon_id: P1, version: 3, change_note: 'Min note.' }]);
      const notes = await changeNotesFor([row({ id: '10' }), personalRow({ id: '11' })], { query, personal });
      expect(notes.get('10')?.changeNote).toBe('Præciserer tonen.');
      expect(notes.get('11')?.changeNote).toBe('Min note.');
    });
  });
});
