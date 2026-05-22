import { redirect, notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { queryUserSchemaOne } from '@/lib/db/user-schema';
import { TranscriptReview } from '@/components/transcript/TranscriptReview';
import { ProcessStrip } from '@/components/layout/ProcessStrip';
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
    pii_replacements: unknown;
  }>(
    session.user.id,
    'SELECT id, raw_text, segments, pii_removed_at, pii_replacements FROM transcripts WHERE meeting_id = $1 ORDER BY id DESC LIMIT 1',
    [id],
  );

  if (!transcript) {
    return (
      <div>
        <ProcessStrip meetingId={id} activePhase="review" />
        <div className="mx-auto max-w-[720px] px-6 py-12">
          <h1 className="text-xl font-semibold text-[var(--ink)]">Ingen transskription</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Transskriptionen er endnu ikke tilgængelig. Prøv at genindlæse siden.
          </p>
        </div>
      </div>
    );
  }

  const segments: TranscriptSegment[] = Array.isArray(transcript.segments)
    ? (transcript.segments as TranscriptSegment[])
    : [];

  const piiReplacements: PiiReplacement[] = Array.isArray(transcript.pii_replacements)
    ? (transcript.pii_replacements as PiiReplacement[])
    : [];

  return (
    <div>
      <ProcessStrip meetingId={id} activePhase="review" completedPhases={['recording']} />
      <TranscriptReview
        meetingId={id}
        transcriptId={transcript.id}
        initialSegments={segments}
        piiReplacements={piiReplacements}
      />
    </div>
  );
}
