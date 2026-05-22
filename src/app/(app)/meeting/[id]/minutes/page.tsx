import { redirect, notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { queryUserSchemaOne, queryUserSchema } from '@/lib/db/user-schema';
import { MinutesEditor } from '@/components/minutes/MinutesEditor';
import { ProcessStrip } from '@/components/layout/ProcessStrip';
import { MinutesContent } from '@/types';

interface PageProps {
  params: Promise<{ id: string }>;
}

export const dynamic = 'force-dynamic';

export default async function MinutesPage({ params }: PageProps) {
  const { id } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');

  const meeting = await queryUserSchemaOne<{ id: string; status: string; title: string }>(
    session.user.id,
    'SELECT id, status, title FROM meetings WHERE id = $1',
    [id],
  );
  if (!meeting) notFound();

  if (meeting.status === 'recording') redirect(`/meeting/${id}`);
  if (meeting.status === 'review') redirect(`/meeting/${id}/review`);

  const minutesRow = await queryUserSchemaOne<{
    id: string;
    content: unknown;
    version: number;
    created_at: string;
  }>(
    session.user.id,
    'SELECT id, content, version, created_at FROM minutes WHERE meeting_id = $1 ORDER BY version DESC LIMIT 1',
    [id],
  );

  if (!minutesRow) {
    return (
      <div>
        <ProcessStrip meetingId={id} activePhase="minutes" completedPhases={['recording', 'review']} />
        <div className="mx-auto max-w-[720px] px-6 py-12">
          <h1 className="text-xl font-semibold text-[var(--ink)]">Ingen referat endnu</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Gå tilbage til{' '}
            <a href={`/meeting/${id}/review`} className="text-[var(--accent)]">
              transskriptionsvisningen
            </a>{' '}
            for at generere et referat.
          </p>
        </div>
      </div>
    );
  }

  const versions = await queryUserSchema<{
    id: string;
    content: unknown;
    created_at: string;
  }>(
    session.user.id,
    'SELECT id, content, created_at FROM minute_versions WHERE minutes_id = $1 ORDER BY created_at DESC LIMIT 20',
    [minutesRow.id],
  );

  const content = minutesRow.content as MinutesContent;

  return (
    <div>
      <ProcessStrip meetingId={id} activePhase="minutes" completedPhases={['recording', 'review']} />
      <MinutesEditor
        meetingId={id}
        minutesId={minutesRow.id}
        initialContent={content}
        version={minutesRow.version}
        versions={versions.map((v) => ({
          id: v.id,
          createdAt: v.created_at,
          content: v.content as MinutesContent,
        }))}
      />
    </div>
  );
}
