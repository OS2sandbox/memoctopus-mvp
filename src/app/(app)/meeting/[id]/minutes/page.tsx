'use client';

import React from 'react';
import { MeetingPageClient } from '@/components/meeting/MeetingPageClient';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function MinutesPage({ params }: PageProps) {
  const { id } = React.use(params);
  return <MeetingPageClient meetingId={id} initialTab="minutes" />;
}
