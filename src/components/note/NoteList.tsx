'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { listNotes, StoredMeeting } from '@/lib/storage';
import { formatDate } from '@/lib/utils';
import { ErrorBanner } from '@/components/ui/error-banner';

type Loaded =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; notes: StoredMeeting[] };

// The Arkiv's Noter tab. It loads its own list, as SkabelonerList does, so the
// meeting tab never sees a note.
export function NoteList() {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    listNotes().then(
      (notes) => { if (!cancelled) setLoaded({ status: 'ready', notes }); },
      (err) => {
        console.error('[arkiv] could not read notes from local storage:', err);
        if (!cancelled) setLoaded({ status: 'failed' });
      },
    );
    return () => { cancelled = true; };
  }, []);

  if (loaded.status === 'loading') {
    return (
      <div className="py-8">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-14 bg-[var(--fill)] rounded mb-2 animate-pulse" />
        ))}
      </div>
    );
  }

  if (loaded.status === 'failed') {
    return (
      <ErrorBanner
        message="Dine noter kunne ikke indlæses. Genindlæs siden, og prøv igen."
        onRetry={() => window.location.reload()}
        className="mt-4"
      />
    );
  }

  if (loaded.notes.length === 0) {
    return (
      <div className="py-16 text-center">
        <p className="text-[var(--muted)]" style={{ fontSize: 'var(--t-body)' }}>
          Du har ingen noter endnu.
        </p>
        <Link href="/dashboard" className="mt-4 inline-block text-sm text-[var(--accent)] hover:underline">
          Indtal din første note →
        </Link>
      </div>
    );
  }

  return (
    <div className="border border-[var(--line)] rounded-[var(--radius)] bg-[var(--surface)] divide-y divide-[var(--line)]">
      {loaded.notes.map((note) => (
        <Link
          key={note.id}
          href={`/note/${note.id}`}
          className="flex flex-col px-5 py-4 hover:bg-[var(--surface-2)] transition-colors"
        >
          <span className="font-medium text-[var(--ink)] truncate" style={{ fontSize: 'var(--t-body)' }}>
            {note.title}
          </span>
          <span className="mt-0.5 text-[var(--muted)]" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--t-micro)' }}>
            {formatDate(note.createdAt)}
          </span>
        </Link>
      ))}
    </div>
  );
}
