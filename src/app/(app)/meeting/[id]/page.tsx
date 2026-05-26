import { redirect, notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { queryUserSchemaOne } from '@/lib/db/user-schema';
import { RecordingScreen } from '@/components/recording/RecordingScreen';
import { ProcessStrip } from '@/components/layout/ProcessStrip';

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

  return (
    <div>
      <ProcessStrip meetingId={id} activePhase="recording" />
      <RecordingScreen meetingId={id} />
    </div>
  );
}
