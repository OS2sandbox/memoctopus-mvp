import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setStorageUserId } from './scope';
import { createMeeting, getMeeting } from './meetings';
import { getTranscript } from './transcripts';
import { createNote, getNote, listNotes, saveNoteText, appendNoteText } from './notes';

// Each test runs against its own user's database, so nothing leaks between tests.
beforeEach(() => {
  setStorageUserId(crypto.randomUUID());
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createNote', () => {
  it('stores a finished local meeting of kind note with an empty text', async () => {
    const note = await createNote();

    expect(await getMeeting(note.id)).toMatchObject({ kind: 'note', status: 'done', source: 'local' });
    expect(await getTranscript(note.id)).toMatchObject({ rawText: '', segments: [] });
    expect(await getNote(note.id)).toMatchObject({ note: { id: note.id }, text: '' });
  });
});

describe('getNote', () => {
  it('answers null for a meeting that is not a note', async () => {
    const meeting = await createMeeting({ title: 'Møde' });
    expect(await getNote(meeting.id)).toBeNull();
  });
});

describe('saveNoteText', () => {
  it('replaces the text', async () => {
    const note = await createNote();
    await saveNoteText(note.id, 'første');
    await saveNoteText(note.id, 'anden');
    expect((await getNote(note.id))?.text).toBe('anden');
  });
});

describe('appendNoteText', () => {
  it.each([
    { before: '', added: 'Hej', after: 'Hej' },
    { before: 'Første afsnit', added: 'Andet afsnit', after: 'Første afsnit\n\nAndet afsnit' },
    { before: 'Første afsnit\n', added: ' Andet afsnit ', after: 'Første afsnit\n\nAndet afsnit' },
    { before: 'Første afsnit', added: '  ', after: 'Første afsnit' },
  ])('joins $added onto $before with a blank line', async ({ before, added, after }) => {
    const note = await createNote();
    await saveNoteText(note.id, before);

    expect(await appendNoteText(note.id, added)).toBe(after);
    expect((await getNote(note.id))?.text).toBe(after);
  });

  // createNote writes the meeting and its transcript record separately; a tab closed
  // between the two leaves a note without one.
  it('keeps the text of a note that has no transcript record yet', async () => {
    const note = await createMeeting({ title: 'Note', kind: 'note', status: 'done', source: 'local' });

    expect(await appendNoteText(note.id, 'Hej')).toBe('Hej');
    expect((await getNote(note.id))?.text).toBe('Hej');
  });
});

describe('listNotes', () => {
  it('returns only notes, newest first', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T10:00:00.000Z'));
    const older = await createNote();
    vi.setSystemTime(new Date('2026-01-01T11:00:00.000Z'));
    await createMeeting({ title: 'Møde' });
    vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
    const newer = await createNote();

    expect((await listNotes()).map((n) => n.id)).toEqual([newer.id, older.id]);
  });
});
