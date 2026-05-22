import { redirect, notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { queryUserSchemaOne } from '@/lib/db/user-schema';
import { TranscriptReview } from '@/components/transcript/TranscriptReview';
import { TranscriptSegment, PiiReplacement } from '@/types';

interface PageProps {
  params: Promise<{ id: string }>;
}

export const dynamic = 'force-dynamic';

export default async function TranscriptReviewPage({ params }: PageProps) {
  const { id } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');

  const meeting = await queryUserSchemaOne<{ id: string; status: string; title: string }>(
    session.user.id,
    'SELECT id, status, title FROM meetings WHERE id = $1',
    [id],
  );
  if (!meeting) notFound();

  if (meeting.status === 'recording' || meeting.status === 'processing') {
    redirect(`/meeting/${id}`);
  }
  if (meeting.status === 'minutes' || meeting.status === 'done') {
    redirect(`/meeting/${id}/minutes`);
  }

  const transcript = await queryUserSchemaOne<{
    id: string;
    raw_text: string;
    segments: unknown;
    pii_removed_at: string | null;
  }>(
    session.user.id,
    'SELECT id, raw_text, segments, pii_removed_at FROM transcripts WHERE meeting_id = $1 ORDER BY id DESC LIMIT 1',
    [id],
  );

  if (!transcript) {
    return (
      <div className="mx-auto max-w-[720px] px-4 py-8">
        <h1 className="text-xl font-semibold text-[var(--text)]">Ingen transskription</h1>
        <p className="mt-2 text-sm text-[var(--text-muted)]">
          Transskriptionen er endnu ikke tilgængelig. Prøv at genindlæse siden.
        </p>
      </div>
    );
  }

  const segments: TranscriptSegment[] = Array.isArray(transcript.segments)
    ? (transcript.segments as TranscriptSegment[])
    : [];

  // PII replacements are stored in a separate column if present
  // For now we pass empty array — they would come from the transcribe pipeline
  const piiReplacements: PiiReplacement[] = [];

  return (
    <div>
      <div className="border-b border-[var(--border)] bg-[var(--surface)] px-4 py-3">
        <div className="mx-auto max-w-[960px]">
          <p className="text-sm font-medium text-[var(--text)]">{meeting.title}</p>
          <nav className="flex gap-4 mt-1">
            {['Optagelse', 'Gennemsyn', 'Referat', 'Eksport'].map((step, i) => (
              <span
                key={step}
                className={`text-xs ${i === 1 ? 'text-[var(--accent)] font-medium' : 'text-[var(--text-muted)]'}`}
              >
                {step}
              </span>
            ))}
          </nav>
        </div>
      </div>
      <TranscriptReview
        meetingId={id}
        transcriptId={transcript.id}
        initialSegments={segments}
        piiReplacements={piiReplacements}
      />
    </div>
  );
}
