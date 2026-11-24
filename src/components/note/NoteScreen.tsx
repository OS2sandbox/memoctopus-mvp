'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useIsMobile } from '@/lib/use-is-mobile';
import { useCopyToClipboard } from '@/lib/use-copy';
import { downloadExport } from '@/lib/export-client';
import { appendNoteText, createNote, deleteMeeting, getNote, saveNoteText } from '@/lib/storage';
import { useNoteRecorder } from './use-note-recorder';

type Loaded = { status: 'loading' } | { status: 'missing' } | { status: 'ready'; title: string };

const mono: React.CSSProperties = { fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 500 };

const actionButton: React.CSSProperties = {
  ...mono,
  padding: '8px 14px',
  borderRadius: 'var(--radius)',
  border: '1px solid var(--line-2)',
  background: 'transparent',
  color: 'var(--ink)',
  cursor: 'pointer',
};

const EXPORTS = [
  { format: 'docx', label: 'download Word', filename: 'note.docx' },
  { format: 'pdf', label: 'download PDF', filename: 'note.pdf' },
] as const;

// One note: record, read and edit its text, record more onto it, copy or export it.
// The text lives in IndexedDB (src/lib/storage/notes.ts); every edit is written at
// once, so a recording appended afterwards lands after what was typed.
// shortcut: leaving while recording loses the take without asking, revisit if users lose dictations that way (src/lib/recording/leave-guard.ts can ask).
export function NoteScreen({ noteId, autostart }: { noteId: string; autostart: boolean }) {
  const router = useRouter();
  const isMobile = useIsMobile();
  const recorder = useNoteRecorder(noteId);
  const clipboard = useCopyToClipboard();
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const autostarted = useRef(false);

  const { start } = recorder;
  useEffect(() => {
    let cancelled = false;
    getNote(noteId).then(
      (found) => {
        if (cancelled) return;
        if (!found) {
          setLoaded({ status: 'missing' });
          return;
        }
        setText(found.text);
        setLoaded({ status: 'ready', title: found.note.title });
        // The flag is dropped from the address, so reloading the page does not record again.
        if (autostart && !autostarted.current) {
          autostarted.current = true;
          router.replace(`/note/${noteId}`);
          void start();
        }
      },
      (err) => {
        console.error('[note] could not be loaded', noteId, err);
        if (!cancelled) setLoaded({ status: 'missing' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [noteId, autostart, router, start]);

  async function save(next: string) {
    setText(next);
    try {
      await saveNoteText(noteId, next);
    } catch (err) {
      console.error('[note] could not be saved', noteId, err);
      setError('Noten kunne ikke gemmes. Kopiér teksten for at beholde den.');
    }
  }

  async function stop() {
    const take = await recorder.stop();
    if (!take) return;
    try {
      const next = await appendNoteText(noteId, take);
      if (next !== null) setText(next);
    } catch (err) {
      console.error('[note] could not be saved', noteId, err);
      setText((current) => (current.trim() ? `${current.trimEnd()}\n\n${take}` : take));
      setError('Noten kunne ikke gemmes. Kopiér teksten for at beholde den.');
    }
  }

  async function exportAs(format: (typeof EXPORTS)[number]['format'], filename: string, title: string) {
    setBusy(true);
    setError(null);
    try {
      await downloadExport({ meetingId: noteId, title, content: { body: text }, format, filename });
    } catch (err) {
      // downloadExport throws only Error, with its own Danish fallback message.
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function newNote() {
    setBusy(true);
    setError(null);
    try {
      const note = await createNote();
      router.push(`/note/${note.id}?autostart=1`);
    } catch (err) {
      console.error('[note] could not create a new note', err);
      setError('Der kunne ikke oprettes en ny note. Prøv igen.');
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm('Vil du slette noten? Den kan ikke gendannes.')) return;
    setBusy(true);
    setError(null);
    try {
      await deleteMeeting(noteId);
      router.push('/dashboard');
    } catch (err) {
      console.error('[note] could not be deleted', noteId, err);
      setError('Noten kunne ikke slettes. Prøv igen.');
      setBusy(false);
    }
  }

  if (loaded.status === 'loading') return null;

  if (loaded.status === 'missing') {
    return (
      <div style={{ maxWidth: 560, margin: '64px auto', padding: '0 16px', textAlign: 'center' }}>
        <p style={{ fontSize: 15, color: 'var(--ink-2)', marginBottom: 20 }}>Noten findes ikke. Den kan være slettet.</p>
        <Link href="/dashboard" style={{ ...mono, color: 'var(--ink-2)' }}>↶ til forsiden</Link>
      </div>
    );
  }

  const idle = recorder.state === 'idle';
  const hasText = text.trim() !== '';
  const shownError = recorder.error ?? error;

  return (
    <div style={{ minHeight: 'calc(100vh - 56px)', padding: isMobile ? '40px 20px' : '64px 32px' }}>
      <div style={{ maxWidth: 780, margin: '0 auto' }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', letterSpacing: 0.4 }}>note</div>
        <h1 style={{ fontWeight: 300, fontSize: isMobile ? 30 : 38, lineHeight: 1.04, letterSpacing: '-0.025em', margin: '8px 0 0' }}>
          {loaded.title}
        </h1>

        {shownError && (
          <div role="alert" style={{
            marginTop: 20, padding: '12px 16px', borderRadius: 'var(--radius)',
            background: 'var(--kill-wash)', borderLeft: '3px solid var(--kill)',
            fontSize: 13.5, color: 'var(--kill)',
          }}>
            {shownError}
          </div>
        )}

        <div style={{ marginTop: 32, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          {recorder.state === 'recording' ? (
            <button
              type="button"
              onClick={() => void stop()}
              style={{ ...mono, padding: '12px 22px', borderRadius: 'var(--radius)', border: '1px solid var(--kill)', background: 'var(--kill)', color: '#fff', cursor: 'pointer' }}
            >
              stop
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void start()}
              disabled={!idle || busy}
              style={{ ...mono, padding: '12px 22px', borderRadius: 'var(--radius)', border: '1px solid var(--accent)', background: 'var(--accent)', color: '#fff', cursor: idle && !busy ? 'pointer' : 'not-allowed', opacity: idle && !busy ? 1 : 0.7 }}
            >
              {hasText ? 'fortsæt noten' : 'optag'}
            </button>
          )}
          <span role="status" style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)' }}>
            {recorder.state === 'recording' ? 'optager…' : recorder.state === 'transcribing' ? 'transskriberer…' : ''}
          </span>
        </div>

        <textarea
          aria-label="Notens tekst"
          value={text}
          onChange={(e) => void save(e.target.value)}
          readOnly={!idle}
          placeholder="Klik på optag, og begynd at tale. Teksten vises, når du stopper optagelsen."
          rows={14}
          style={{
            marginTop: 20, width: '100%', boxSizing: 'border-box', resize: 'vertical',
            padding: '16px 18px', borderRadius: 'var(--radius)', border: '1px solid var(--line-2)',
            background: 'var(--surface)', color: 'var(--ink)', font: 'inherit', fontSize: 15, lineHeight: 1.6,
          }}
        />
        {recorder.state === 'transcribing' && recorder.text && (
          <p style={{ marginTop: 12, fontSize: 15, lineHeight: 1.6, color: 'var(--muted)' }}>{recorder.text}</p>
        )}

        <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => void clipboard.copy(text)} disabled={!hasText} style={actionButton}>kopiér</button>
          {EXPORTS.map((e) => (
            <button
              key={e.format}
              type="button"
              onClick={() => void exportAs(e.format, e.filename, loaded.title)}
              disabled={!hasText || !idle || busy}
              style={actionButton}
            >
              {e.label}
            </button>
          ))}
          <span role="status" style={{ fontFamily: 'var(--mono)', fontSize: 12, color: clipboard.failed ? 'var(--danger)' : 'var(--muted)' }}>
            {clipboard.failed ? 'kunne ikke kopiere' : clipboard.copied ? 'kopieret' : ''}
          </span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
            <button type="button" onClick={() => void newNote()} disabled={!idle || busy} style={actionButton}>ny note</button>
            <button type="button" onClick={() => void remove()} disabled={!idle || busy} style={{ ...actionButton, color: 'var(--kill)' }}>slet noten</button>
          </span>
        </div>
      </div>
    </div>
  );
}
