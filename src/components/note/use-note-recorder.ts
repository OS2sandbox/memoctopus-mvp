'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { transcribeBatchesOnServer } from '@/lib/audio/transcribe-batches-client';
import { pickRecordingMimeType } from '@/lib/audio/recording-format';
import type { TranscriptSegment } from '@/types';

type NoteRecorderState = 'idle' | 'recording' | 'transcribing';

// Batches stream back in the order they finish, not the order they were spoken.
function textOf(segments: TranscriptSegment[]): string {
  return [...segments]
    .sort((a, b) => a.start - b.start)
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(' ');
}

function startErrorMessage(err: unknown): string {
  if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
    return 'Browseren har ikke adgang til mikrofonen. Giv adgang i adresselinjen, og prøv igen.';
  }
  if (err instanceof DOMException && (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError')) {
    return 'Browseren kan ikke finde en mikrofon. Tjek, at den er tilsluttet.';
  }
  return 'Optagelsen kunne ikke starte. Prøv igen.';
}

// Records a note in memory and transcribes it when stopped. The audio exists only
// in this hook's refs until the transcription is back, and is never stored.
// shortcut: text appears after stop, not live while speaking, revisit once recording resilience has landed by extracting RecordingScreen's caption engine.
// shortcut: a failed transcription loses the take, revisit if users report lost dictations.
export function useNoteRecorder(noteId: string) {
  const [state, setState] = useState<NoteRecorderState>('idle');
  // The text of the take being transcribed, filled in as batches arrive.
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const releaseMicrophone = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(
    () => () => {
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
      recorderRef.current = null;
      chunksRef.current = [];
      releaseMicrophone();
    },
    [releaseMicrophone],
  );

  const start = useCallback(async () => {
    setError(null);
    setText('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = pickRecordingMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.start(1000);
      recorderRef.current = recorder;
      setState('recording');
    } catch (err) {
      releaseMicrophone();
      setError(startErrorMessage(err));
    }
  }, [releaseMicrophone]);

  // Resolves with the take's text: '' when nothing was said or the transcription
  // failed (then `error` says so).
  const stop = useCallback(async (): Promise<string> => {
    const recorder = recorderRef.current;
    if (!recorder) return '';
    recorderRef.current = null;
    let audio: Blob;
    try {
      // A recorder whose microphone went away has already stopped by itself, with its
      // last chunk delivered, and stopping it again throws.
      if (recorder.state !== 'inactive') {
        await new Promise<void>((resolve) => {
          recorder.onstop = () => resolve();
          recorder.stop();
        });
      }
      audio = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
    } catch (err) {
      console.error('[note] recording could not be stopped:', err);
      setError('Optagelsen kunne ikke stoppes og er ikke gemt. Optag igen.');
      setState('idle');
      return '';
    } finally {
      chunksRef.current = [];
      releaseMicrophone();
    }

    setState('transcribing');
    const arrived: TranscriptSegment[] = [];
    try {
      const result = await transcribeBatchesOnServer(noteId, audio, {
        onBatch: (update) => {
          arrived.push(...update.segments);
          setText(textOf(arrived));
        },
      });
      const final = textOf(result.segments);
      setText(final);
      return final;
    } catch (err) {
      console.error('[note] transcription failed:', err);
      setError('Optagelsen kunne ikke transskriberes og er ikke gemt. Optag igen.');
      return '';
    } finally {
      setState('idle');
    }
  }, [noteId, releaseMicrophone]);

  return { state, text, error, start, stop };
}
