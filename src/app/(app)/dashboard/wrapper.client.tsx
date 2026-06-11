'use client';

import dynamic from 'next/dynamic';

// ssr: false — dashboard uses MediaRecorder and AudioContext which are browser-only
const Dashboard = dynamic(() => import('./dashboard.client'), { ssr: false });

export function DashboardWrapper() {
  return <Dashboard />;
}
