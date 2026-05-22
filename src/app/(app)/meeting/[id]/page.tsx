import { redirect, notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { queryUserSchemaOne } from '@/lib/db/user-schema';
import { RecordingScreen } from '@/components/recording/RecordingScreen';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function MeetingRecordPage({ params }: PageProps) {
  const { id } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');

  const meeting = await queryUserSchemaOne<{ id: string; status: string; title: string }>(
    session.user.id,
    'SELECT id, status, title FROM meetings WHERE id = $1',
    [id],
  );

  if (!meeting) notFound();

  // If already processed, redirect to appropriate page
  if (meeting.status === 'review') redirect(`/meeting/${id}/review`);
  if (meeting.status === 'minutes' || meeting.status === 'done') {
    redirect(`/meeting/${id}/minutes`);
  }

  return (
    <div>
      <div className="border-b border-[var(--line)] bg-[var(--surface)] px-4 py-3">
        <div className="mx-auto max-w-[720px]">
          <p className="text-sm font-medium text-[var(--ink)]">{meeting.title}</p>
        </div>
      </div>
      <RecordingScreen meetingId={id} />
    </div>
  );
}
