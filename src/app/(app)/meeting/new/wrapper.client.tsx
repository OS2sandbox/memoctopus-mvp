'use client';

import dynamic from 'next/dynamic';

const NewMeetingForm = dynamic(() => import('./form.client'), { ssr: false });

export function NewMeetingWrapper() {
  return <NewMeetingForm />;
}
