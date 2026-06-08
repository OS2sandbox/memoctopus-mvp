'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatDate, formatDuration, statusLabel, statusVariant } from '@/lib/utils';
import { Meeting } from '@/types';

type ArchiveMeeting = Pick<Meeting, 'id' | 'title' | 'participants' | 'status' | 'createdAt'> & {
  durationSeconds: number | null;
};

function statusHref(m: ArchiveMeeting) {
  if (m.status === 'recording' || m.status === 'processing') return `/meeting/${m.id}`;
  if (m.status === 'review') return `/meeting/${m.id}/review`;
  return `/meeting/${m.id}/minutes`;
}

export function ArchiveMeetingRow({ meeting }: { meeting: ArchiveMeeting }) {
  const router = useRouter();
  const [hovered, setHovered] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  async function handleDelete() {
    setIsDeleting(true);
    try {
      await fetch(`/api/meetings/${meeting.id}`, { method: 'DELETE' });
      setDeleteOpen(false);
      router.refresh();
    } catch {
      setIsDeleting(false);
    }
  }

  return (
    <>
      <div
        className="relative flex items-center gap-4 px-5 py-4 hover:bg-[var(--surface-2)] transition-colors"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <Link href={statusHref(meeting)} className="flex flex-1 min-w-0 items-center gap-4">
          <div className="flex-1 min-w-0">
            <p className="font-medium text-[var(--ink)] truncate" style={{ fontSize: 'var(--t-body)' }}>
              {meeting.title}
            </p>
            <p className="mt-0.5 text-[var(--muted)]" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--t-micro)' }}>
              {formatDate(meeting.createdAt)}
              {meeting.durationSeconds != null && (
                <> · {formatDuration(meeting.durationSeconds)}</>
              )}
              {meeting.participants.length > 0 && (
                <> · {meeting.participants.length} deltager{meeting.participants.length !== 1 ? 'e' : ''}</>
              )}
            </p>
          </div>
          <Badge variant={statusVariant(meeting.status)}>
            {statusLabel(meeting.status)}
          </Badge>
        </Link>

        <button
          onClick={(e) => {
            e.preventDefault();
            setDeleteOpen(true);
          }}
          className="ml-1 p-1.5 rounded text-[var(--muted)] hover:text-red-500 hover:bg-red-50 transition-colors"
          style={{ opacity: hovered ? 1 : 0, pointerEvents: hovered ? 'auto' : 'none' }}
          aria-label="Slet møde"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6" />
            <path d="M14 11v6" />
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
          </svg>
        </button>
      </div>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Slet dette møde?</DialogTitle>
            <DialogDescription>
              Alt indhold slettes permanent — lyd, transskription og referat.
              Denne handling kan ikke fortrydes.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteOpen(false)} disabled={isDeleting}>
              Annullér
            </Button>
            <Button variant="destructive" size="sm" onClick={handleDelete} disabled={isDeleting}>
              Slet møde
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
