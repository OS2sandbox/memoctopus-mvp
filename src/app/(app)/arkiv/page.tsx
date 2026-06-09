'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { getAllMeetings, StoredMeeting } from '@/lib/storage';
import { ArchiveMeetingRow } from '@/components/archive-meeting-row';
import { Meeting } from '@/types';

export default function ArkivPage() {
  const [meetings, setMeetings] = useState<(Meeting & { durationSeconds: number | null })[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getAllMeetings()
      .then((rows) => {
        const mapped = rows
          .filter((r) => r.status !== 'joining')
          .map((r: StoredMeeting) => ({
            id: r.id,
            title: r.title,
            participants: r.participants,
            status: r.status,
            createdAt: new Date(r.createdAt),
            updatedAt: new Date(r.updatedAt),
            durationSeconds: r.audioDurationSeconds,
          }));
        setMeetings(mapped);
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="mx-auto max-w-[1040px] px-6 py-12">
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1
            style={{
              fontSize: 'var(--t-h1)',
              fontWeight: 300,
              color: 'var(--ink)',
              margin: 0,
              lineHeight: 1.2,
            }}
          >
            Arkiv
          </h1>
          {!loading && (
            <p className="mt-1 text-[var(--muted)]" style={{ fontSize: 'var(--t-small)' }}>
              {meetings.length} møder
            </p>
          )}
        </div>
      </div>

      {loading ? (
        <div className="py-8">
          {[...Array(3)].map((_, i) => (
            <div
              key={i}
              className="h-14 bg-[var(--fill)] rounded mb-2 animate-pulse"
            />
          ))}
        </div>
      ) : meetings.length === 0 ? (
        <div className="py-16 text-center">
          <p className="text-[var(--muted)]" style={{ fontSize: 'var(--t-body)' }}>
            Du har ikke optaget noget endnu.
          </p>
          <Link
            href="/dashboard"
            className="mt-4 inline-block text-sm text-[var(--accent)] hover:underline"
          >
            Start dit første møde →
          </Link>
        </div>
      ) : (
        <div className="border border-[var(--line)] rounded-[var(--radius)] bg-[var(--surface)] divide-y divide-[var(--line)]">
          {meetings.map((m) => (
            <ArchiveMeetingRow
              key={m.id}
              meeting={m}
              onDeleted={() => setMeetings((prev) => prev.filter((x) => x.id !== m.id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}
