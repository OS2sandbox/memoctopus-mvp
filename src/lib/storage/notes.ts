import { getDB, StoredMeeting, StoredTranscript } from './db';
import { createMeeting, getAllMeetings, getMeeting } from './meetings';
import { getTranscript, saveTranscript } from './transcripts';

// A note is a dictation kept beside the meetings: a StoredMeeting with kind 'note'
// whose whole text is its transcript record's rawText. It never has audio, speakers
// or a referat, so it is born 'done'.

export async function createNote(): Promise<StoredMeeting> {
  const date = new Intl.DateTimeFormat('da', { day: 'numeric', month: 'long' }).format(new Date());
  const note = await createMeeting({ title: `Note · ${date}`, kind: 'note', status: 'done', source: 'local' });
  await saveTranscript(note.id, { rawText: '', segments: [], chapters: [], piiReplacements: [] });
  return note;
}

export async function getNote(id: string): Promise<{ note: StoredMeeting; text: string } | null> {
  const note = await getMeeting(id);
  if (note?.kind !== 'note') return null;
  return { note, text: (await getTranscript(id))?.rawText ?? '' };
}

export async function listNotes(): Promise<StoredMeeting[]> {
  return (await getAllMeetings()).filter((m) => m.kind === 'note');
}

// Reads and writes in one transaction, so an append landing while the text is being
// saved cannot be lost to the other write. A note deleted meanwhile is left deleted.
// The transcript record is made here when missing: createNote writes it separately,
// and a tab closed in between leaves the note without one.
async function writeNoteText(id: string, next: (current: string) => string): Promise<string | null> {
  const db = await getDB();
  const tx = db.transaction(['meetings', 'transcripts'], 'readwrite');
  const meeting = await tx.objectStore('meetings').get(id);
  if (meeting?.kind !== 'note') {
    await tx.done;
    return null;
  }
  const transcript: StoredTranscript = (await tx.objectStore('transcripts').index('by-meeting').getAll(id))[0] ?? {
    id: crypto.randomUUID(),
    meetingId: id,
    rawText: '',
    segments: [],
    chapters: [],
    piiReplacements: [],
    piiRemovedAt: null,
  };
  const text = next(transcript.rawText);
  await tx.objectStore('transcripts').put({ ...transcript, rawText: text, segments: [] });
  await tx.objectStore('meetings').put({ ...meeting, updatedAt: new Date().toISOString() });
  await tx.done;
  return text;
}

export async function saveNoteText(id: string, text: string): Promise<void> {
  await writeNoteText(id, () => text);
}

// Each recording is its own paragraph.
export async function appendNoteText(id: string, addition: string): Promise<string | null> {
  return writeNoteText(id, (current) => {
    const added = addition.trim();
    const kept = current.trimEnd();
    if (!added) return current;
    return kept ? `${kept}\n\n${added}` : added;
  });
}
