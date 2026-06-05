import { headers } from 'next/headers';
import Link from 'next/link';
import { auth } from '@/lib/auth';
import { queryUserSchema } from '@/lib/db/user-schema';
import { formatDate, formatDuration, statusLabel, statusVariant } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Meeting } from '@/types';

export const dynamic = 'force-dynamic';

export default async function ArkivPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;

  const rows = await queryUserSchema<{
    id: string;
    title: string;
    participants: string[];
    status: string;
    created_at: string;
    updated_at: string;
    duration_seconds: number | null;
  }>(session.user.id, `
    SELECT m.*, af.duration_seconds
    FROM meetings m
    LEFT JOIN (
      SELECT DISTINCT ON (meeting_id) meeting_id, duration_seconds
      FROM audio_files
      WHERE deleted_at IS NULL
      ORDER BY meeting_id, id DESC
    ) af ON af.meeting_id = m.id
    ORDER BY m.created_at DESC
    LIMIT 200
  `);

  const meetings = rows.map((r) => ({
    id: r.id,
    title: r.title,
    participants: r.participants,
    status: r.status as Meeting['status'],
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
    durationSeconds: r.duration_seconds,
  }));

  function statusHref(m: Meeting) {
    if (m.status === 'recording' || m.status === 'processing') return `/meeting/${m.id}`;
    if (m.status === 'review') return `/meeting/${m.id}/review`;
    if (m.status === 'minutes') return `/meeting/${m.id}/minutes`;
    return `/meeting/${m.id}/minutes`;
  }

  return (
    <div className="mx-auto max-w-[1040px] px-6 py-12">
      {/* Header */}
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
          <p className="mt-1 text-[var(--muted)]" style={{ fontSize: 'var(--t-small)' }}>
            {meetings.length} møder
          </p>
        </div>
      </div>

      {meetings.length === 0 ? (
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
            <Link
              key={m.id}
              href={statusHref(m)}
              className="flex items-center gap-4 px-5 py-4 hover:bg-[var(--surface-2)] transition-colors"
            >
              <div className="flex-1 min-w-0">
                <p className="font-medium text-[var(--ink)] truncate" style={{ fontSize: 'var(--t-body)' }}>
                  {m.title}
                </p>
                <p className="mt-0.5 text-[var(--muted)]" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--t-micro)' }}>
                  {formatDate(m.createdAt)}
                  {m.durationSeconds != null && (
                    <> · {formatDuration(m.durationSeconds)}</>
                  )}
                  {m.participants.length > 0 && (
                    <> · {m.participants.length} deltager{m.participants.length !== 1 ? 'e' : ''}</>
                  )}
                </p>
              </div>
              <Badge variant={statusVariant(m.status)}>
                {statusLabel(m.status)}
              </Badge>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
