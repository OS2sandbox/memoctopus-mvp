'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { getMeeting, listMeetingIdsWithRecordingState, type StoredMeeting } from '@/lib/storage';

// Recordings left mid-meeting (closed tab, navigation, crash). A meeting still
// `recording` with ledger rows is one; a `processing` one with rows was stopped and
// is finished by RecordingRecovery, so it is not listed. The link opens the meeting,
// whose page offers to resume, finish or delete it. The Arkiv badges the same
// meetings; arkiv/page.test.tsx replays both against one set of cases.
export function InterruptedRecordingBanner() {
  const [interrupted, setInterrupted] = useState<StoredMeeting[]>([]);

  useEffect(() => {
    let cancelled = false;
    listMeetingIdsWithRecordingState()
      .then((ids) => Promise.all(ids.map((id) => getMeeting(id))))
      .then((rows) => {
        if (cancelled) return;
        setInterrupted(rows.filter((m): m is StoredMeeting => m?.status === 'recording'));
      })
      .catch((err: unknown) => {
        console.warn('[InterruptedRecordingBanner] could not read the recording ledger:', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (interrupted.length === 0) return null;

  return (
    <div style={{
      maxWidth: 560, margin: '32px auto 0', padding: '10px 14px',
      border: '1px solid var(--line-2)', borderRadius: 'var(--radius)', background: 'var(--bg-2)',
    }}>
      {interrupted.map((m) => (
        <div key={m.id} style={{
          display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap',
          fontFamily: 'var(--mono)', fontSize: 12.5, padding: '2px 0',
        }}>
          <span style={{ color: 'var(--muted)' }}>optagelsen blev afbrudt</span>
          <span style={{ color: 'var(--ink)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {m.title}
          </span>
          <Link
            href={`/meeting/${m.id}`}
            aria-label={`Fortsæt optagelsen af ${m.title}`}
            style={{ color: 'var(--ink-2)', textDecoration: 'underline', textDecorationColor: 'var(--line-2)', textUnderlineOffset: 3 }}
          >
            fortsæt optagelse →
          </Link>
        </div>
      ))}
    </div>
  );
}
