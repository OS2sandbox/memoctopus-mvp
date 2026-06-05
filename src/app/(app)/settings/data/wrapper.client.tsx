'use client';

import dynamic from 'next/dynamic';

// ssr: false — page fetches usage data client-side on mount
const DataSettingsForm = dynamic(() => import('./form.client'), { ssr: false });

export function DataSettingsWrapper() {
  return <DataSettingsForm />;
}
