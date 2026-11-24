// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setStorageUserId } from '@/lib/storage/scope';
import { createNote, getNote, listNotes, saveNoteText } from '@/lib/storage/notes';

const push = vi.fn();
const replace = vi.fn();
// Next hands out one router object for the page's lifetime.
const router = { push, replace };
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const downloadExport = vi.hoisted(() => vi.fn());
vi.mock('@/lib/export-client', () => ({ downloadExport }));

import { NoteScreen } from './NoteScreen';

// Hands over everything recorded as one chunk when stopped.
class FakeMediaRecorder {
  static isTypeSupported = () => true;
  mimeType = 'audio/webm';
  state = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['lyd'], { type: 'audio/webm' }) });
    this.onstop?.();
  }
}

// The transcribe-batches route's NDJSON reply for one finished take.
function transcribed(text: string) {
  const line = JSON.stringify({ type: 'done', segments: [{ speaker: 'Taler 1', start: 0, end: 2, text }], failedSeconds: 0 });
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(line + '\n'));
      c.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

const fetchMock = vi.fn();
const getUserMedia = vi.fn();

beforeEach(() => {
  setStorageUserId(crypto.randomUUID());
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  getUserMedia.mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function noteWith(text: string) {
  const note = await createNote();
  await saveNoteText(note.id, text);
  return note.id;
}

const textField = () => screen.getByRole('textbox', { name: 'Notens tekst' }) as HTMLTextAreaElement;

describe('NoteScreen', () => {
  it('starts recording at once with autostart, and shows and saves the text when stopped', async () => {
    const id = await noteWith('');
    fetchMock.mockResolvedValue(transcribed('Hej verden'));
    render(<NoteScreen noteId={id} autostart />);

    fireEvent.click(await screen.findByRole('button', { name: 'stop' }));

    await waitFor(() => expect(textField().value).toBe('Hej verden'));
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/meetings/${id}/transcribe-batches`);
    expect((await getNote(id))?.text).toBe('Hej verden');
    expect(replace).toHaveBeenCalledWith(`/note/${id}`);
  });

  it('does not record until asked without autostart', async () => {
    const id = await noteWith('');
    render(<NoteScreen noteId={id} autostart={false} />);

    await screen.findByRole('button', { name: 'optag' });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('appends a continued recording as a new paragraph', async () => {
    const id = await noteWith('Første afsnit');
    fetchMock.mockResolvedValue(transcribed('Andet afsnit'));
    render(<NoteScreen noteId={id} autostart={false} />);

    fireEvent.click(await screen.findByRole('button', { name: 'fortsæt noten' }));
    fireEvent.click(await screen.findByRole('button', { name: 'stop' }));

    await waitFor(() => expect(textField().value).toBe('Første afsnit\n\nAndet afsnit'));
    expect((await getNote(id))?.text).toBe('Første afsnit\n\nAndet afsnit');
  });

  it('saves what the user types', async () => {
    const id = await noteWith('Hej');
    render(<NoteScreen noteId={id} autostart={false} />);

    await waitFor(() => expect(textField().value).toBe('Hej'));
    fireEvent.change(textField(), { target: { value: 'Hej igen' } });

    await waitFor(async () => expect((await getNote(id))?.text).toBe('Hej igen'));
  });

  it('copies the text to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, writable: true, value: { writeText } });
    const id = await noteWith('Hej verden');
    render(<NoteScreen noteId={id} autostart={false} />);

    await waitFor(() => expect(textField().value).toBe('Hej verden'));
    fireEvent.click(screen.getByRole('button', { name: 'kopiér' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Hej verden'));
    expect(await screen.findByText('kopieret')).toBeTruthy();
  });

  it.each([
    { label: 'download Word', format: 'docx', filename: 'note.docx' },
    { label: 'download PDF', format: 'pdf', filename: 'note.pdf' },
  ])('exports the text through $label', async ({ label, format, filename }) => {
    downloadExport.mockResolvedValue(undefined);
    const id = await noteWith('Hej verden');
    render(<NoteScreen noteId={id} autostart={false} />);

    await waitFor(() => expect(textField().value).toBe('Hej verden'));
    fireEvent.click(screen.getByRole('button', { name: label }));

    await waitFor(() => expect(downloadExport).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: id, format, filename, content: { body: 'Hej verden' } }),
    ));
  });

  it('creates a new note and opens it recording', async () => {
    const id = await noteWith('Hej');
    render(<NoteScreen noteId={id} autostart={false} />);

    fireEvent.click(await screen.findByRole('button', { name: 'ny note' }));

    await waitFor(() => expect(push).toHaveBeenCalled());
    const other = (await listNotes()).find((n) => n.id !== id);
    expect(push).toHaveBeenCalledWith(`/note/${other!.id}?autostart=1`);
  });

  it('deletes the note after confirmation', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    const id = await noteWith('Hej');
    render(<NoteScreen noteId={id} autostart={false} />);

    fireEvent.click(await screen.findByRole('button', { name: 'slet noten' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard'));
    expect(await getNote(id)).toBeNull();
  });

  it('says so when the note does not exist', async () => {
    render(<NoteScreen noteId="findes-ikke" autostart />);

    expect(await screen.findByText(/Noten findes ikke/)).toBeTruthy();
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});
