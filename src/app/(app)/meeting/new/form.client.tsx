'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createMeeting, saveAudio, saveTranscript, updateMeeting } from '@/lib/storage';
import type { TranscriptSegment, PiiReplacement } from '@/types';
import type { TranscriptChapter } from '@/lib/ai/chapters';

const schema = z.object({
  title: z.string().min(2, 'Titel skal have mindst 2 tegn').max(200),
  participants: z.string().optional(),
});

type FormData = z.infer<typeof schema>;

const AUDIO_MODES = [
  { value: 'record' as const, label: 'Optag nu', description: 'Start optagelse med mikrofon' },
  { value: 'upload' as const, label: 'Upload lydfil', description: 'MP3, WAV, M4A, WebM' },
];

export default function NewMeetingPage() {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadMode, setUploadMode] = useState<'record' | 'upload'>('record');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormData>({ resolver: zodResolver(schema) });

  async function onSubmit(data: FormData) {
    setIsSubmitting(true);
    setError(null);
    try {
      const participants = data.participants
        ? data.participants
            .split(',')
            .map((p) => p.trim())
            .filter(Boolean)
        : [];

      const meeting = await createMeeting({
        title: data.title,
        participants: participants.length > 0 ? participants : undefined,
        source: 'local',
        status: 'recording',
      });

      if (uploadMode === 'upload' && file) {
        await saveAudio(meeting.id, file, file.type || 'audio/webm');
        await updateMeeting(meeting.id, { status: 'processing', audioSizeBytes: file.size });

        const formData = new FormData();
        formData.append('audio', file, file.name);
        formData.append('meetingId', meeting.id);
        const res = await fetch('/api/transcribe', { method: 'POST', body: formData });
        if (!res.ok) {
          const d = await res.json();
          throw new Error(d.error ?? 'Upload fejlede');
        }
        const result = await res.json() as {
          segments: TranscriptSegment[];
          piiReplacements: PiiReplacement[];
          rawText: string;
          chapters: TranscriptChapter[];
        };
        await saveTranscript(meeting.id, {
          rawText: result.rawText,
          segments: result.segments,
          chapters: result.chapters ?? [],
          piiReplacements: result.piiReplacements ?? [],
        });
        await updateMeeting(meeting.id, { status: 'review' });
        router.push(`/meeting/${meeting.id}/review`);
      } else {
        router.push(`/meeting/${meeting.id}?autostart=1`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Noget gik galt');
      setIsSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-[720px] px-4 py-8">
      <h1 className="text-xl font-semibold text-[var(--ink)] mb-1">Nyt møde</h1>
      <p className="text-sm text-[var(--muted)] mb-8">
        Udfyld oplysningerne og vælg om du vil optage nu eller uploade en lydfil.
      </p>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <div className="space-y-1.5">
          <Label htmlFor="title">Mødets titel</Label>
          <Input
            id="title"
            placeholder="f.eks. Bestyrelsesmøde maj 2026"
            {...register('title')}
            aria-invalid={!!errors.title}
          />
          {errors.title && (
            <p className="text-xs text-[var(--danger)]">{errors.title.message}</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="participants">
            Deltagere{' '}
            <span className="text-[var(--muted)] font-normal">(valgfri, kommasepareret)</span>
          </Label>
          <Input
            id="participants"
            placeholder="f.eks. Formand, Næstformand, Kasserer"
            {...register('participants')}
          />
        </div>

        <div className="space-y-2">
          <Label>Lydkilde</Label>
          <div className="flex gap-3">
            {AUDIO_MODES.map(({ value, label, description }) => (
              <button
                key={value}
                type="button"
                onClick={() => setUploadMode(value)}
                className={`flex-1 rounded-[var(--radius)] border px-4 py-3 text-left text-sm transition-colors ${
                  uploadMode === value
                    ? 'border-[var(--accent)] bg-[var(--accent-wash)] text-[var(--accent)]'
                    : 'border-[var(--line)] bg-[var(--surface)] text-[var(--ink-2)] hover:bg-[var(--surface-2)]'
                }`}
              >
                <span className="font-medium block">{label}</span>
                <span className="text-xs opacity-75">{description}</span>
              </button>
            ))}
          </div>
        </div>

        {uploadMode === 'upload' && (
          <div className="space-y-1.5">
            <Label htmlFor="audioFile">Lydfil</Label>
            <input
              id="audioFile"
              type="file"
              accept="audio/*"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm text-[var(--ink-2)] file:mr-3 file:py-2 file:px-3 file:rounded-[var(--radius)] file:border file:border-[var(--line)] file:bg-[var(--surface-2)] file:text-sm file:font-medium file:text-[var(--ink)] hover:file:bg-[var(--line)] file:cursor-pointer cursor-pointer"
            />
            {!file && (
              <p className="text-xs text-[var(--muted)]">
                Vælg en lydfil fra din computer.
              </p>
            )}
          </div>
        )}

        {error && (
          <div
            className="rounded-[var(--radius)] border px-4 py-3 text-sm text-[var(--danger)]"
            style={{ backgroundColor: 'var(--danger-wash)', borderColor: 'var(--danger)' }}
          >
            {error}
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => router.push('/dashboard')}
          >
            Annullér
          </Button>
          <Button
            type="submit"
            disabled={isSubmitting || (uploadMode === 'upload' && !file)}
          >
            {isSubmitting
              ? uploadMode === 'upload' ? 'Behandler…' : 'Opretter...'
              : uploadMode === 'record'
              ? 'Start optagelse'
              : 'Upload og transskribér'}
          </Button>
        </div>
      </form>
    </div>
  );
}
