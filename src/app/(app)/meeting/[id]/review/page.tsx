import { redirect, notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { getMeetingPageData } from '@/lib/data/meeting-page';
import { MeetingPageClient } from '@/components/meeting/MeetingPageClient';

interface PageProps {
  params: Promise<{ id: string }>;
}

export const dynamic = 'force-dynamic';

export default async function TranscriptReviewPage({ params }: PageProps) {
  const { id } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/');

  const data = await getMeetingPageData(session.user.id, id);
  if (!data) notFound();

  if (data.meeting.status === 'recording') {
    redirect(`/meeting/${id}`);
  }

  return <MeetingPageClient meetingId={id} initialTab="review" data={data} />;
}
