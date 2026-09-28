'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { deleteMeeting } from '@/lib/storage';

/**
 * Dead end for meetings started by the old Playwright bot.
 *
 * Such a meeting exists only in a browser's IndexedDB from before the Graph
 * integration: `source: 'teams'` without the `graphManaged` marker. The
 * bot that would have finished it is gone, so there is nothing to wait for and
 * no way to resume. Without this screen those records would render nothing at
 * all, since MeetingPageClient routes every Teams-sourced meeting away from
 * RecordingScreen.
 *
 * Whatever the bot did manage to transcribe is still in IndexedDB and reachable
 * from the Gennemgang tab, so the notice offers that as well as deleting.
 */
export function LegacyBotMeetingScreen({
  meetingId,
  hasTranscript,
  onOpenReview,
}: {
  meetingId: string;
  hasTranscript: boolean;
  onOpenReview: () => void;
}) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);

  async function remove() {
    setDeleting(true);
    try {
      await deleteMeeting(meetingId);
      router.push('/dashboard');
    } catch {
      setDeleting(false);
    }
  }

  return (
    <div style={{ maxWidth: 560, margin: '64px auto', padding: '0 16px', textAlign: 'center' }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted)', marginBottom: 12 }}>
        Mødet kan ikke genoptages
      </div>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 12 }}>
        Dette møde blev startet med den gamle Teams-robot
      </h1>
      <p style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--muted)', marginBottom: 24 }}>
        Memoctopus sender ikke længere en robot ind i Teams-møder. Referater hentes nu fra
        Teams&rsquo; egen transskription, og det kræver, at mødet slås til inden det starter.
        Robotten, der skulle have optaget dette møde, findes ikke længere.
      </p>
      <p style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--muted)', marginBottom: 32 }}>
        {hasTranscript
          ? 'Den transskription, robotten nåede at lave, ligger stadig under Gennemgang.'
          : 'Der blev ikke gemt nogen transskription for mødet.'}
      </p>
      <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
        {hasTranscript && (
          <button
            type="button"
            onClick={onOpenReview}
            style={{
              padding: '10px 18px',
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'transparent',
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Åbn Gennemgang
          </button>
        )}
        <button
          type="button"
          onClick={remove}
          disabled={deleting}
          style={{
            padding: '10px 18px',
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: 'transparent',
            fontSize: 14,
            cursor: deleting ? 'default' : 'pointer',
            opacity: deleting ? 0.6 : 1,
          }}
        >
          {deleting ? 'Sletter…' : 'Slet mødet'}
        </button>
      </div>
      <p style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--muted)', marginTop: 32 }}>
        Nye Teams-møder tilføjes ved at indsætte mødelinket på forsiden.
      </p>
    </div>
  );
}
