'use client';

import dynamic from 'next/dynamic';

// ssr: false — form uses browser-only APIs (fetch with FormData, router hooks)
const NewMeetingForm = dynamic(() => import('./form.client'), { ssr: false });

export function NewMeetingWrapper() {
  return <NewMeetingForm />;
}
