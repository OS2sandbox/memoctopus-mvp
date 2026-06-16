'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { getAllMeetings, deleteMeeting, StoredMeeting } from '@/lib/storage';
import { ArchiveMeetingRow } from '@/components/archive-meeting-row';
import { SkabelonerList } from '@/components/skabeloner/SkabelonerList';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Meeting } from '@/types';

type Tab = 'meetings' | 'skabeloner';

export default function ArkivPage() {
  const [meetings, setMeetings] = useState<(Meeting & { durationSeconds: number | null })[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('meetings');
  const [editMode, setEditMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  // Allow deep-linking to the Skabeloner tab (e.g. from the old /templates route).
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('tab') === 'skabeloner') {
      setTab('skabeloner');
    }
  }, []);

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

  function selectTab(next: Tab) {
    setTab(next);
    if (next !== 'meetings') exitEditMode();
    const url = next === 'skabeloner' ? '/arkiv?tab=skabeloner' : '/arkiv';
    window.history.replaceState(null, '', url);
  }

  function exitEditMode() {
    setEditMode(false);
    setSelected(new Set());
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allSelected = meetings.length > 0 && selected.size === meetings.length;

  function toggleSelectAll() {
    setSelected(allSelected ? new Set() : new Set(meetings.map((m) => m.id)));
  }

  async function handleBulkDelete() {
    setIsBulkDeleting(true);
    const ids = [...selected];
    // Each delete removes the meeting plus its transcript, referat and audio.
    await Promise.all(ids.map((id) => deleteMeeting(id).catch(() => {})));
    setMeetings((prev) => prev.filter((m) => !selected.has(m.id)));
    setBulkDeleteOpen(false);
    setIsBulkDeleting(false);
    exitEditMode();
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'meetings', label: 'Møder' },
    { key: 'skabeloner', label: 'Skabeloner' },
  ];

  return (
    <div className="mx-auto max-w-[1040px] px-6 py-12">
      <div className="flex items-start justify-between mb-6">
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
          {tab === 'meetings' && !loading && (
            <p className="mt-1 text-[var(--muted)]" style={{ fontSize: 'var(--t-small)' }}>
              {meetings.length} møder
            </p>
          )}
        </div>

        {tab === 'meetings' && !loading && meetings.length > 0 && !editMode && (
          <Button variant="outline" size="sm" onClick={() => setEditMode(true)}>
            Rediger arkiv
          </Button>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex gap-6 border-b border-[var(--line)] mb-8">
        {tabs.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => selectTab(t.key)}
              style={{
                position: 'relative',
                padding: '8px 0',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontSize: 14,
                fontWeight: active ? 500 : 400,
                color: active ? 'var(--ink)' : 'var(--muted)',
                borderBottom: '2px solid ' + (active ? 'var(--accent)' : 'transparent'),
                marginBottom: -1,
                transition: 'color 120ms',
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'meetings' ? (
        loading ? (
          <div className="py-8">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-14 bg-[var(--fill)] rounded mb-2 animate-pulse" />
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
          <>
            {editMode && (
              <div className="flex items-center justify-between mb-3">
                <button
                  onClick={toggleSelectAll}
                  className="text-sm text-[var(--accent)] hover:underline"
                >
                  {allSelected ? 'Fravælg alle' : 'Vælg alle'}
                </button>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={exitEditMode}>
                    Færdig
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={selected.size === 0}
                    onClick={() => setBulkDeleteOpen(true)}
                  >
                    Slet valgte ({selected.size})
                  </Button>
                </div>
              </div>
            )}
            <div className="border border-[var(--line)] rounded-[var(--radius)] bg-[var(--surface)] divide-y divide-[var(--line)]">
              {meetings.map((m) => (
                <ArchiveMeetingRow
                  key={m.id}
                  meeting={m}
                  selectionMode={editMode}
                  selected={selected.has(m.id)}
                  onToggleSelect={() => toggleSelect(m.id)}
                  onDeleted={() => setMeetings((prev) => prev.filter((x) => x.id !== m.id))}
                />
              ))}
            </div>
          </>
        )
      ) : (
        <SkabelonerList />
      )}

      <Dialog open={bulkDeleteOpen} onOpenChange={(o) => !isBulkDeleting && setBulkDeleteOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Slet {selected.size} {selected.size === 1 ? 'møde' : 'møder'}?
            </DialogTitle>
            <DialogDescription>
              Alt indhold slettes permanent — lyd, transskription og referat.
              Denne handling kan ikke fortrydes.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setBulkDeleteOpen(false)} disabled={isBulkDeleting}>
              Annullér
            </Button>
            <Button variant="destructive" size="sm" onClick={handleBulkDelete} disabled={isBulkDeleting}>
              {isBulkDeleting
                ? 'Sletter…'
                : `Slet ${selected.size} ${selected.size === 1 ? 'møde' : 'møder'}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
