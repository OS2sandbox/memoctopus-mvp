'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { createMeeting, updateMeeting, deleteMeeting } from '@/lib/storage';

export interface CalendarMeetingRow {
  eventId: string;
  subject: string;
  start: string;
  end: string;
  joinUrl: string | null;
  isOrganizer: boolean;
  isRecurring: boolean;
  armedMeetingId: string | null;
}

type ArmResult = 'armed' | 'not_organizer' | 'policy_blocked';

interface RowState {
  meetingId: string;
  armResult: ArmResult;
  isRecurring: boolean;
}

export const ORGANIZER_REQUEST =
  'Kan du slå "Optag og transskriber automatisk" til i mødeindstillingerne for dette møde? Så laver Memoctopus referatet automatisk.';

const ADMIN_GUIDE = '/docs/setup-microsoft-teams.md';

// Danish copy for every error shape the Teams routes can answer with.
export function armErrorMessage(status: number, error?: string): string {
  switch (error) {
    case 'invalid-url':
    case 'wrong-host':
      return 'Mødelinket er ikke et gyldigt Teams-link.';
    case 'not_invited':
      return 'Du skal være inviteret til mødet for at kunne tage referat.';
    case 'consent_required':
      return 'Memoctopus mangler adgang til dine Teams-møder. Log ind med Microsoft igen.';
    case 'reauth_required':
      return 'Din adgang til Microsoft er udløbet. Log ind med Microsoft igen.';
    case 'transcripts_disabled':
      return 'Jeres Teams-opsætning tillader ikke, at Memoctopus henter transskriptioner. Kontakt jeres IT-administrator.';
    default:
      return status === 401
        ? 'Du er ikke logget ind længere. Genindlæs siden.'
        : 'Kunne ikke slå referat til for mødet. Prøv igen.';
  }
}

function fmtWhen(start: string, end: string): string {
  const s = new Date(start);
  if (Number.isNaN(s.getTime())) return '';
  const day = new Intl.DateTimeFormat('da', { weekday: 'short', day: 'numeric', month: 'short' }).format(s);
  const from = new Intl.DateTimeFormat('da', { hour: '2-digit', minute: '2-digit' }).format(s);
  const e = new Date(end);
  const to = Number.isNaN(e.getTime())
    ? null
    : new Intl.DateTimeFormat('da', { hour: '2-digit', minute: '2-digit' }).format(e);
  return to ? `${day} · ${from}–${to}` : `${day} · ${from}`;
}

export function UpcomingTeamsMeetings() {
  const [meetings, setMeetings] = useState<CalendarMeetingRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch('/api/teams/calendar?days=7');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setLoadError(armErrorMessage(res.status, (body as { error?: string }).error));
        setMeetings([]);
        return;
      }
      const data = (await res.json()) as { meetings?: CalendarMeetingRow[] };
      const list = data.meetings ?? [];
      setMeetings(list);
      const preArmed: Record<string, RowState> = {};
      for (const m of list) {
        if (m.armedMeetingId) {
          preArmed[m.eventId] = { meetingId: m.armedMeetingId, armResult: 'armed', isRecurring: m.isRecurring };
        }
      }
      setRows(preArmed);
    } catch (err) {
      console.warn('[UpcomingTeamsMeetings] kalender kunne ikke hentes:', err);
      setLoadError('Kunne ikke hente dine kommende Teams-møder.');
      setMeetings([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const arm = useCallback(async (m: CalendarMeetingRow) => {
    if (busy || !m.joinUrl) return;
    setBusy(m.eventId);
    setRowErrors((prev) => { const next = { ...prev }; delete next[m.eventId]; return next; });
    let localId: string | null = null;
    try {
      const local = await createMeeting({
        title: m.subject,
        source: 'teams',
        meetingUrl: m.joinUrl,
        status: 'awaiting_teams',
        teamsSubject: m.subject,
        scheduledStart: m.start,
        scheduledEnd: m.end,
      });
      localId = local.id;

      const res = await fetch('/api/teams/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The occurrence, not just the series: a recurring meeting has one
        // onlineMeeting whose window is the series', so without these the
        // artifacts of occurrence 2+ fall outside the server's pick window.
        body: JSON.stringify({
          meetingId: local.id,
          joinUrl: m.joinUrl,
          eventId: m.eventId,
          scheduledStart: m.start,
          scheduledEnd: m.end,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setRowErrors((prev) => ({ ...prev, [m.eventId]: armErrorMessage(res.status, (body as { error?: string }).error) }));
        await deleteMeeting(local.id).catch(() => {});
        return;
      }
      const data = (await res.json()) as { armed: boolean; armResult: ArmResult; isOrganizer: boolean };
      await updateMeeting(local.id, {
        teamsArmed: data.armed,
        teamsIsOrganizer: data.isOrganizer,
      }).catch(() => {});
      setRows((prev) => ({
        ...prev,
        [m.eventId]: { meetingId: local.id, armResult: data.armResult, isRecurring: m.isRecurring },
      }));
    } catch (err) {
      console.error('[UpcomingTeamsMeetings] kunne ikke slå referat til:', err);
      setRowErrors((prev) => ({ ...prev, [m.eventId]: 'Kunne ikke slå referat til for mødet. Prøv igen.' }));
      if (localId) await deleteMeeting(localId).catch(() => {});
    } finally {
      setBusy(null);
    }
  }, [busy]);

  if (meetings === null) {
    return (
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted-2)' }}>
        henter kommende Teams-møder…
      </div>
    );
  }

  return (
    <section aria-label="Kommende Teams-møder">
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)',
        letterSpacing: 0.4, marginBottom: 12,
      }}>
        kommende teams-møder
      </div>

      {loadError && (
        <div role="alert" style={{ fontSize: 13, color: 'var(--error, #e05252)' }}>{loadError}</div>
      )}

      {!loadError && meetings.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>
          Ingen Teams-møder i de næste 7 dage.
        </div>
      )}

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {meetings.map((m) => {
          const row = rows[m.eventId];
          const err = rowErrors[m.eventId];
          return (
            <li
              key={m.eventId}
              style={{
                border: '1px solid var(--line)', borderRadius: 10,
                padding: '12px 14px', background: 'var(--surface)',
              }}
            >
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div style={{ fontSize: 14.5, color: 'var(--ink)' }}>{m.subject}</div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted)', marginTop: 3 }}>
                    {fmtWhen(m.start, m.end)}
                  </div>
                </div>

                {row ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span
                      data-testid={`armed-${m.eventId}`}
                      style={{
                        padding: '5px 10px', borderRadius: 999, fontSize: 12,
                        background: 'var(--keep, #e7f5ec)', border: '1px solid var(--line-2)',
                        color: 'var(--ink)',
                      }}
                    >
                      Referat slået til
                    </span>
                    <Link
                      href={`/meeting/${row.meetingId}`}
                      style={{ fontSize: 12.5, color: 'var(--ink-2)', textDecoration: 'underline' }}
                    >
                      Åbn
                    </Link>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => { void arm(m); }}
                    disabled={!m.joinUrl || busy === m.eventId}
                    style={{
                      padding: '7px 14px', borderRadius: 999, fontSize: 12.5,
                      border: 'none', background: m.joinUrl ? 'var(--accent)' : 'var(--sunk)',
                      color: m.joinUrl ? '#fff' : 'var(--muted-2)',
                      cursor: m.joinUrl && busy !== m.eventId ? 'pointer' : 'default',
                    }}
                  >
                    {busy === m.eventId ? '…' : 'Tag referat'}
                  </button>
                )}
              </div>

              {row?.armResult === 'armed' && row.isRecurring && (
                <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--muted)' }}>
                  Hele serien optages.
                </div>
              )}

              {row?.armResult === 'not_organizer' && (
                <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6 }}>
                  Du er ikke organisator, så vi kan ikke slå optagelse til. Send denne besked til organisatoren:
                  <blockquote style={{
                    margin: '8px 0 0', padding: '10px 12px', borderRadius: 8,
                    background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--ink-2)',
                  }}>
                    {ORGANIZER_REQUEST}
                  </blockquote>
                </div>
              )}

              {row?.armResult === 'policy_blocked' && (
                <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6 }}>
                  Jeres Teams-politik blokerer automatisk optagelse og transskription. Bed jeres
                  IT-administrator følge trin 2 i{' '}
                  <a href={ADMIN_GUIDE} style={{ color: 'var(--ink-2)' }}>opsætningsguiden</a>.
                </div>
              )}

              {!m.joinUrl && (
                <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--muted)' }}>
                  Mødet har ikke noget Teams-link.
                </div>
              )}

              {err && (
                <div role="alert" style={{ marginTop: 8, fontSize: 12.5, color: 'var(--error, #e05252)' }}>{err}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
