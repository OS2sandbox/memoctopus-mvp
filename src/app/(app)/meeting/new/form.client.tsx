'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createMeeting } from '@/lib/storage';
import { takePendingUploadFiles } from '@/lib/pending-upload';
import { UploadConfirmScreen } from './upload-confirm.client';
import { UploadOrderList } from '@/components/upload/UploadOrderList';
import { OnboardingHint } from '@/components/onboarding/OnboardingHint';

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
  const [error, setError] = useState<string | null>(null);

  // Files passed from the dashboard "upload lydfil" picker. Several files are one
  // meeting recorded in parts: the user puts them in order before transcription.
  const [uploadFiles, setUploadFiles] = useState<File[]>(() => takePendingUploadFiles());
  const [ordering, setOrdering] = useState(() => uploadFiles.length > 1);

  // useForm must be called unconditionally (Rules of Hooks) even when we render
  // UploadConfirmScreen instead of this form.
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormData>({ resolver: zodResolver(schema) });

  function pickFiles(files: File[]) {
    setUploadFiles(files);
    setOrdering(files.length > 1);
  }

  function cancelUpload() {
    pickFiles([]);
    router.push('/dashboard');
  }

  if (ordering) {
    return (
      <UploadOrderList
        files={uploadFiles}
        onChange={setUploadFiles}
        onConfirm={() => setOrdering(false)}
        onCancel={cancelUpload}
      />
    );
  }

  if (uploadFiles.length > 0) {
    return <UploadConfirmScreen files={uploadFiles} onCancel={cancelUpload} />;
  }

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

      // The upload path is handled by UploadConfirmScreen (rendered when files are
      // chosen). This submit handler only covers the "record now" path.
      const meeting = await createMeeting({
        title: data.title,
        participants: participants.length > 0 ? participants : undefined,
        source: 'local',
        status: 'recording',
      });
      router.push(`/meeting/${meeting.id}?autostart=1`);
    } catch (err) {
      console.error('[new-meeting] createMeeting failed:', err);
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
          <OnboardingHint stepId="meeting-new.participants-field">
            <Input
              id="participants"
              placeholder="f.eks. Formand, Næstformand, Kasserer"
              {...register('participants')}
            />
          </OnboardingHint>
        </div>

        <div className="space-y-2">
          <Label>Lydkilde</Label>
          <div className="flex gap-3">
            {AUDIO_MODES.map(({ value, label, description }) => {
              const button = (
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
              );

              if (value === 'upload') {
                return (
                  <OnboardingHint key={value} stepId="meeting-new.upload-mode">
                    {button}
                  </OnboardingHint>
                );
              }

              return button;
            })}
          </div>
        </div>

        {uploadMode === 'upload' && (
          <div className="space-y-1.5">
            <Label htmlFor="audioFile">Lydfil</Label>
            <input
              id="audioFile"
              type="file"
              accept="audio/*"
              multiple
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length > 0) {
                  pickFiles(files);
                  e.currentTarget.value = '';
                }
              }}
              className="block w-full text-sm text-[var(--ink-2)] file:mr-3 file:py-2 file:px-3 file:rounded-[var(--radius)] file:border file:border-[var(--line)] file:bg-[var(--surface-2)] file:text-sm file:font-medium file:text-[var(--ink)] hover:file:bg-[var(--line)] file:cursor-pointer cursor-pointer"
            />
            <p className="text-xs text-[var(--muted)]">
              Vælg én eller flere lydfiler fra din computer. Flere filer samles til én optagelse.
            </p>
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
          {uploadMode !== 'upload' && (
            <OnboardingHint stepId="meeting-new.record-mic-permission">
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Opretter...' : 'Start optagelse'}
              </Button>
            </OnboardingHint>
          )}
        </div>
      </form>
    </div>
  );
}
