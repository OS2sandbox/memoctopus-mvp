'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { signIn } from '@/lib/auth-client';
import { saveAudio, updateMeeting, deleteMeeting } from '@/lib/storage';

export interface TeamsMeetingScreenProps {
  meetingId: string;
  meetingUrl: string;
}

export type TeamsState = 'awaiting_teams' | 'fetching' | 'ready' | 'failed' | 'needs_reauth';

interface TeamsMeetingStatus {
  id: string;
  state: TeamsState;
  armed: boolean;
  isOrganizer: boolean;
  subject: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  failureReason: string | null;
  lastPolledAt: string | null;
  armResult?: TeamsArmResult;
  mode?: string;
}

export type TeamsArmResult = 'armed' | 'not_organizer' | 'policy_blocked';

const ADMIN_GUIDE = '/docs/setup-microsoft-teams.md';

/** How long to keep asking for the stashed recording before giving up on it. */
const AUDIO_COLLECT_DEADLINE_MS = 2 * 60_000;
const AUDIO_COLLECT_RETRY_MS = 500;

const FAST_POLL_MS = 15_000;
const SLOW_POLL_MS = 60_000;
const SLOWDOWN_AFTER_MS = 60 * 60_000;

// The sentence the invitee can hand to the organizer verbatim.
export const ORGANIZER_REQUEST =
  'Kan du slå "Optag og transskriber automatisk" til i mødeindstillingerne for dette møde? Så laver Memoctopus referatet automatisk.';

/**
 * Pull the artifacts the Graph pipeline stashed server-side into IndexedDB, the
 * way MeetingBotScreen does for the Playwright bot. Without this the review
 * screen opens on an empty IndexedDB and fails with "Lydfil ikke fundet".
 *
 * Three answers: 404 (not stashed yet — keep asking), `no-recording` (a
 * transcript-only meeting: no audio exists, but the speaker names do), or the
 * wav itself.
 */
export async function collectTeamsArtifacts(meetingId: string): Promise<void> {
  const deadline = Date.now() + AUDIO_COLLECT_DEADLINE_MS;
  while (Date.now() < deadline) {
    let res: Response;
    try {
      res = await fetch(`/api/meetings/${meetingId}/pending-audio`);
    } catch {
      await new Promise((r) => setTimeout(r, AUDIO_COLLECT_RETRY_MS));
      continue;
    }
    if (res.status === 404) {
      await new Promise((r) => setTimeout(r, AUDIO_COLLECT_RETRY_MS));
      continue;
    }

    const ctype = res.headers.get('content-type') ?? '';
    if (ctype.includes('application/json')) {
      // Transcript-only: the transcript is collected by ProcessingTranscription;
      // all that is needed here are the speaker names from the Teams transcript.
      const body = (await res.json().catch(() => ({}))) as {
        participants?: string[];
        durationSeconds?: number | null;
      };
      await updateMeeting(meetingId, {
        status: 'processing',
        audioDurationSeconds: body.durationSeconds ?? null,
        ...(body.participants?.length ? { participants: body.participants } : {}),
      });
      return;
    }

    const blob = await res.blob();
    const mimeType = ctype || 'audio/wav';
    const partsHeader = res.headers.get('X-Participants');
    const durHeader = res.headers.get('X-Duration');
    let parts: string[] = [];
    if (partsHeader) {
      try { parts = JSON.parse(decodeURIComponent(partsHeader)); } catch { /* ignore */ }
    }
    const duration = durHeader ? parseInt(durHeader, 10) : NaN;

    await saveAudio(meetingId, blob, mimeType);
    await updateMeeting(meetingId, {
      status: 'processing',
      audioSizeBytes: blob.size,
      audioDurationSeconds: Number.isFinite(duration) ? duration : null,
      ...(parts.length > 0 ? { participants: parts } : {}),
    });
    return;
  }
  // Nothing to collect within the deadline: the server-side transcript may still
  // be all there is, so continue to the review screen rather than dead-ending.
  await updateMeeting(meetingId, { status: 'processing' });
}

function fmtRange(start: string | null, end: string | null): string | null {
  if (!start) return null;
  const s = new Date(start);
  if (Number.isNaN(s.getTime())) return null;
  const day = new Intl.DateTimeFormat('da', { weekday: 'long', day: 'numeric', month: 'long' }).format(s);
  const time = new Intl.DateTimeFormat('da', { hour: '2-digit', minute: '2-digit' }).format(s);
  const e = end ? new Date(end) : null;
  const endTime = e && !Number.isNaN(e.getTime())
    ? new Intl.DateTimeFormat('da', { hour: '2-digit', minute: '2-digit' }).format(e)
    : null;
  return endTime ? `${day} · ${time}–${endTime}` : `${day} · ${time}`;
}

export function TeamsMeetingScreen({ meetingId, meetingUrl }: TeamsMeetingScreenProps) {
  const router = useRouter();
  // next/navigation returns a stable router, but keeping it in a ref means the
  // poll callback's identity depends only on the meeting id — a re-created
  // router object can never restart the polling effect mid-meeting.
  const routerRef = useRef(router);
  routerRef.current = router;

  const [status, setStatus] = useState<TeamsMeetingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [intervalMs, setIntervalMs] = useState(FAST_POLL_MS);

  // Guards so an effect re-run never fires a second forced poll or a second
  // navigation to the review page.
  const forcedAfterEndRef = useRef(false);
  const routedRef = useRef(false);
  const inFlightRef = useRef(false);

  const scheduledEndRef = useRef<string | null>(null);

  const poll = useCallback(
    async (explicitForce: boolean) => {
      if (inFlightRef.current) return;
      // The first tick after the meeting's scheduled end asks the server to
      // actually talk to Graph, so artifacts are picked up without waiting for
      // the background poller.
      let force = explicitForce;
      if (!force && !forcedAfterEndRef.current && scheduledEndRef.current) {
        const end = Date.parse(scheduledEndRef.current);
        if (!Number.isNaN(end) && end <= Date.now()) {
          forcedAfterEndRef.current = true;
          force = true;
        }
      }
      inFlightRef.current = true;
      if (force) setChecking(true);
      try {
        const res = await fetch(`/api/teams/meetings/${meetingId}${force ? '?poll=1' : ''}`);
        if (res.status === 404) {
          setError('Mødet er ikke registreret hos Teams. Prøv at tilføje mødelinket igen.');
          return;
        }
        if (!res.ok) {
          setError('Kunne ikke hente status fra Teams. Prøver igen om lidt.');
          return;
        }
        const data = (await res.json()) as TeamsMeetingStatus;
        setError(null);
        setStatus(data);
        scheduledEndRef.current = data.scheduledEnd ?? null;

        if (data.state === 'ready' && !routedRef.current) {
          routedRef.current = true;
          try {
            await collectTeamsArtifacts(meetingId);
          } catch (err) {
            console.error('[TeamsMeetingScreen] kunne ikke hente optagelsen:', err);
            await updateMeeting(meetingId, { status: 'processing' }).catch(() => {});
          }
          routerRef.current.push(`/meeting/${meetingId}/review`);
        }
      } catch (err) {
        console.warn('[TeamsMeetingScreen] poll fejlede:', err);
        setError('Kunne ikke hente status fra Teams. Prøver igen om lidt.');
      } finally {
        inFlightRef.current = false;
        setChecking(false);
      }
    },
    [meetingId],
  );

  useEffect(() => {
    void poll(false);
  }, [poll]);

  useEffect(() => {
    const t = setTimeout(() => setIntervalMs(SLOW_POLL_MS), SLOWDOWN_AFTER_MS);
    return () => clearTimeout(t);
  }, []);

  const state = status?.state;
  const stopped = state === 'ready' || state === 'failed' || state === 'needs_reauth';

  useEffect(() => {
    if (stopped) return;
    const id = setInterval(() => { void poll(false); }, intervalMs);
    return () => clearInterval(id);
  }, [poll, intervalMs, stopped]);

  const disarm = useCallback(async () => {
    try {
      await fetch(`/api/teams/meetings/${meetingId}`, { method: 'DELETE' });
    } catch (err) {
      console.warn('[TeamsMeetingScreen] disarm fejlede:', err);
    }
    try {
      await deleteMeeting(meetingId);
    } catch (err) {
      console.error('[TeamsMeetingScreen] deleteMeeting fejlede:', err);
    }
    routerRef.current.push('/dashboard');
  }, [meetingId]);

  const reauth = useCallback(() => {
    void signIn.social({ provider: 'microsoft', callbackURL: `/meeting/${meetingId}` });
  }, [meetingId]);

  const copyRequest = useCallback(() => {
    void navigator.clipboard?.writeText(ORGANIZER_REQUEST).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  }, []);

  const when = fmtRange(status?.scheduledStart ?? null, status?.scheduledEnd ?? null);

  return (
    <div style={{ padding: '48px 24px', maxWidth: 640, margin: '0 auto' }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: 0.6, color: 'var(--muted-2)' }}>
        teams-møde
      </div>
      <h1 style={{ fontWeight: 300, fontSize: 30, margin: '10px 0 0', letterSpacing: '-0.02em' }}>
        {status?.subject || 'Teams-møde'}
      </h1>
      {when && (
        <div style={{ marginTop: 8, fontSize: 14, color: 'var(--muted)' }}>{when}</div>
      )}

      <div style={{ marginTop: 20, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        {meetingUrl && (
          <a
            href={meetingUrl}
            target="_blank"
            rel="noreferrer noopener"
            style={{
              padding: '8px 14px', borderRadius: 999, fontSize: 13,
              border: '1px solid var(--line-2)', color: 'var(--ink)', textDecoration: 'none',
            }}
          >
            Åbn i Teams
          </a>
        )}
        {status?.armed && (
          <span
            data-testid="armed-badge"
            style={{
              padding: '6px 12px', borderRadius: 999, fontSize: 12,
              background: 'var(--keep, #e7f5ec)', color: 'var(--ink)',
              border: '1px solid var(--line-2)',
            }}
          >
            Memoctopus er slået til
          </span>
        )}
      </div>

      <div style={{ marginTop: 28, borderTop: '1px solid var(--line)', paddingTop: 24 }}>
        {state === 'awaiting_teams' && status?.armed && (
          <>
            <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6 }}>
              Mødet optages og transskriberes automatisk. Referatet er klar automatisk et par minutter efter mødet.
            </p>
            <p style={{ marginTop: 10, fontSize: 13.5, color: 'var(--muted)' }}>Venter på mødet…</p>
          </>
        )}

        {state === 'awaiting_teams' && status?.armResult === 'policy_blocked' && (
          <>
            <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6 }}>
              Jeres Teams-politik blokerer automatisk optagelse og transskription, så Memoctopus
              kunne ikke slå det til for mødet. Bed jeres IT-administrator følge trin 2 i{' '}
              <a href={ADMIN_GUIDE} style={{ color: 'var(--ink-2)' }}>opsætningsguiden</a>.
            </p>
            <p style={{ marginTop: 14, fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
              Transskriptionen hentes stadig automatisk, hvis nogen starter transskription undervejs i mødet.
            </p>
          </>
        )}

        {state === 'awaiting_teams' && status && !status.armed
          && status.armResult !== 'policy_blocked' && (
          <>
            <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6 }}>
              Du er inviteret til mødet, men ikke organisator, så Memoctopus kan ikke slå optagelse til for dig.
              Bed organisatoren om at slå automatisk optagelse og transskription til:
            </p>
            <blockquote
              style={{
                margin: '14px 0 0', padding: '12px 14px', borderRadius: 8,
                background: 'var(--bg-2)', border: '1px solid var(--line)',
                fontSize: 13.5, lineHeight: 1.6, color: 'var(--ink-2)',
              }}
            >
              {ORGANIZER_REQUEST}
            </blockquote>
            <button
              type="button"
              onClick={copyRequest}
              style={{
                marginTop: 10, padding: '6px 12px', borderRadius: 999, fontSize: 12.5,
                border: '1px solid var(--line-2)', background: 'transparent',
                color: 'var(--ink-2)', cursor: 'pointer',
              }}
            >
              {copied ? 'Kopieret' : 'Kopiér beskeden'}
            </button>
            <p style={{ marginTop: 14, fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
              Transskriptionen hentes stadig automatisk, hvis nogen starter transskription undervejs i mødet.
            </p>
          </>
        )}

        {state === 'fetching' && (
          <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6 }}>
            Mødet er slut. Henter transskription fra Teams — det tager typisk et par minutter.
          </p>
        )}

        {state === 'ready' && (
          <p style={{ margin: 0, fontSize: 15 }}>Transskriptionen er hentet. Åbner gennemgangen…</p>
        )}

        {state === 'failed' && (
          <>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 500 }}>Der kom intet referat ud af mødet</h2>
            <p style={{ marginTop: 8, fontSize: 14, color: 'var(--muted)', lineHeight: 1.6 }}>
              {status?.failureReason || 'Transskriptionen blev aldrig startet i Teams.'}
            </p>
          </>
        )}

        {state === 'needs_reauth' && (
          <>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 500 }}>Adgangen til Microsoft er udløbet</h2>
            <p style={{ marginTop: 8, fontSize: 14, color: 'var(--muted)', lineHeight: 1.6 }}>
              Log ind med Microsoft igen, så henter vi transskriptionen.
            </p>
            <button
              type="button"
              onClick={reauth}
              style={{
                marginTop: 14, padding: '9px 16px', borderRadius: 8, fontSize: 13,
                background: 'var(--ink)', color: 'var(--bg)', border: 'none', cursor: 'pointer',
              }}
            >
              Log ind med Microsoft igen
            </button>
          </>
        )}

        {error && (
          <p role="alert" style={{ marginTop: 14, fontSize: 13, color: 'var(--error, #e05252)' }}>{error}</p>
        )}
      </div>

      <div style={{ marginTop: 28, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => { void poll(true); }}
          disabled={checking}
          style={{
            padding: '9px 16px', borderRadius: 8, fontSize: 13,
            border: '1px solid var(--line-2)', background: 'transparent',
            color: 'var(--ink)', cursor: checking ? 'default' : 'pointer',
          }}
        >
          {state === 'failed' ? 'Prøv igen' : 'Tjek nu'}
        </button>
        <button
          type="button"
          onClick={() => { void disarm(); }}
          style={{
            padding: '9px 16px', borderRadius: 8, fontSize: 13,
            border: '1px solid var(--line-2)', background: 'transparent',
            color: 'var(--muted)', cursor: 'pointer',
          }}
        >
          {state === 'failed' ? 'Slet' : 'Slå Memoctopus fra'}
        </button>
      </div>
    </div>
  );
}
