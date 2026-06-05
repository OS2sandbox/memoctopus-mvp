'use client';

import dynamic from 'next/dynamic';

const DataSettingsForm = dynamic(() => import('./form.client'), { ssr: false });

export function DataSettingsWrapper() {
  return <DataSettingsForm />;
}
