import { redirect, notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { queryUserSchemaOne } from '@/lib/db/user-schema';
import { RecordingScreen } from '@/components/recording/RecordingScreen';
import { ProcessStrip } from '@/components/layout/ProcessStrip';

interface PageProps {
  params: Promise<{ id: string }>;
}

export const dynamic = 'force-dynamic';

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

  const audioFile = await queryUserSchemaOne<{
    duration_seconds: number | null;
    size_bytes: number;
  }>(
    session.user.id,
    'SELECT duration_seconds, size_bytes FROM audio_files WHERE meeting_id = $1 AND deleted_at IS NULL LIMIT 1',
    [id],
  );

  const isCompleted = meeting.status !== 'recording' && meeting.status !== 'processing';

  return (
    <div>
      <ProcessStrip
        meetingId={id}
        activePhase="recording"
        completedPhases={isCompleted ? [] : []}
      />
      <RecordingScreen
        meetingId={id}
        existingRecording={
          isCompleted && audioFile
            ? { durationSeconds: audioFile.duration_seconds, sizeBytes: audioFile.size_bytes }
            : undefined
        }
      />
    </div>
  );
}
