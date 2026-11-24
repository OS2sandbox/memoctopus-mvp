'use client';

import React from 'react';
import { NoteScreen } from '@/components/note/NoteScreen';

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ autostart?: string | string[] }>;
}

export default function NotePage({ params, searchParams }: PageProps) {
  const { id } = React.use(params);
  const { autostart } = React.use(searchParams);
  return <NoteScreen noteId={id} autostart={autostart === '1'} />;
}
