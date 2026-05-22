import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import Link from 'next/link';
import { auth } from '@/lib/auth';
import { queryUserSchema } from '@/lib/db/user-schema';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDate, statusLabel, statusVariant } from '@/lib/utils';
import { Meeting } from '@/types';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect('/login');

  const rows = await queryUserSchema<{
    id: string;
    title: string;
    participants: string[];
    status: string;
    created_at: string;
    updated_at: string;
  }>(session.user.id, `SELECT * FROM meetings ORDER BY created_at DESC LIMIT 50`);

  const meetings: Meeting[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    participants: r.participants,
    status: r.status as Meeting['status'],
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  }));

  const statusHref = (m: Meeting) => {
    if (m.status === 'recording' || m.status === 'processing') {
      return `/meeting/${m.id}`;
    }
    if (m.status === 'review') return `/meeting/${m.id}/review`;
    if (m.status === 'minutes') return `/meeting/${m.id}/minutes`;
    return `/meeting/${m.id}/minutes`;
  };

  return (
    <div className="mx-auto max-w-[960px] px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--text)]">Møder</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Hej {session.user.name.split(' ')[0]}. Her er dine møder.
          </p>
        </div>
        <Button asChild>
          <Link href="/meeting/new">Nyt møde</Link>
        </Button>
      </div>

      {meetings.length === 0 ? (
        <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] px-8 py-16 text-center">
          <h2 className="text-base font-medium text-[var(--text)] mb-2">Ingen møder endnu</h2>
          <p className="text-sm text-[var(--text-muted)] mb-6 max-w-sm mx-auto">
            Opret dit første møde for at begynde at optage og udarbejde referater.
          </p>
          <Button asChild>
            <Link href="/meeting/new">Opret første møde</Link>
          </Button>
        </div>
      ) : (
        <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] divide-y divide-[var(--border)]">
          {meetings.map((m) => (
            <Link
              key={m.id}
              href={statusHref(m)}
              className="flex items-center gap-4 px-5 py-4 hover:bg-[var(--surface-2)] transition-colors"
            >
              <div className="flex-1 min-w-0">
                <p className="font-medium text-[var(--text)] truncate">{m.title}</p>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                  {formatDate(m.createdAt)}
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
