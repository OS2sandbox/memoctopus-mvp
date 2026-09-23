'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { signIn } from '@/lib/auth-client';
import { updateMeeting } from '@/lib/storage';
import { deleteMeetingAndUnregister } from '@/lib/teams/client-delete';

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
  /** False when the server has TEAMS_GRAPH_ENABLED off. Absent means on. */
  enabled?: boolean;
}

export type TeamsArmResult = 'armed' | 'armed_in_progress' | 'not_organizer' | 'policy_blocked';

const ADMIN_GUIDE = '/docs/setup-microsoft-teams.md';

/** How long to keep asking for the run’s meta record before giving up on it. */
const META_COLLECT_DEADLINE_MS = 2 * 60_000;
const META_COLLECT_RETRY_MS = 500;

const FAST_POLL_MS = 15_000;
const SLOW_POLL_MS = 60_000;
const SLOWDOWN_AFTER_MS = 60 * 60_000;

// The sentence the invitee can hand to the organizer verbatim.
export const ORGANIZER_REQUEST =
  'Kan du slå "Optag og transskriber automatisk" til i mødeindstillingerne for dette møde? Så laver Memoctopus referatet automatisk.';

/**
 * Fill in what the server-side run produced before Gennemgang opens: the speaker
 * names Teams gave us, and the meeting duration.
 *
 * No audio is collected, because none is stashed. Graph publishes nothing until a
 * meeting has ended, so the recording is transcribed server-side and dropped, and
 * the transcript itself is collected by ProcessingTranscription. Without this step
 * the review screen would open with an empty participant list.
 *
 * Two answers: 404 (the run has not finished — keep asking) or the meta record.
 * Anything else (401, 500 …) throws, so the screen can say so instead of carrying
 * on to a review with an empty participant list.
 */
export async function collectTeamsArtifacts(meetingId: string): Promise<void> {
  const deadline = Date.now() + META_COLLECT_DEADLINE_MS;
  while (Date.now() < deadline) {
    let res: Response;
    try {
      res = await fetch(`/api/meetings/${meetingId}/pending-meta`);
    } catch {
      await new Promise((r) => setTimeout(r, META_COLLECT_RETRY_MS));
      continue;
    }
    if (res.status === 404) {
      await new Promise((r) => setTimeout(r, META_COLLECT_RETRY_MS));
      continue;
    }
    if (!res.ok) throw new Error(`pending-meta svarede ${res.status}`);

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
  // Nothing to collect within the deadline: the server-side transcript may still
  // be all there is, so continue to the review screen rather than dead-ending.
  await updateMeeting(meetingId, { status: 'processing' });
}

/**
 * True when the server no longer holds the transcript of a meeting the row calls
 * `ready`: nobody collected it within the pending-artifacts TTL and it was swept.
 * Anything unclear (a network error, a 500) counts as "still there", so the normal
 * path runs and reports its own error.
 */
async function serverCopyGone(meetingId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/meetings/${meetingId}/pending-transcript`);
    if (res.status === 404) return true;
    if (!res.ok) return false;
    return ((await res.json()) as { status?: string }).status === 'none';
  } catch {
    return false;
  }
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
  // The row is ready but the server no longer holds its transcript.
  const [copyGone, setCopyGone] = useState(false);

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
        setCopyGone(false);
        scheduledEndRef.current = data.scheduledEnd ?? null;

        if (data.state === 'ready' && !routedRef.current) {
          routedRef.current = true;
          // Checked first: with the copy gone there is nothing to open a review on.
          if (await serverCopyGone(meetingId)) {
            routedRef.current = false;
            setCopyGone(true);
            return;
          }
          try {
            await collectTeamsArtifacts(meetingId);
          } catch (err) {
            console.error('[TeamsMeetingScreen] kunne ikke hente transskriptionen:', err);
            // "Tjek nu" polls again, and a ready row then takes this path afresh.
            routedRef.current = false;
            setError('Kunne ikke hente transskriptionen fra serveren. Tryk "Tjek nu" for at prøve igen.');
            return;
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

  // Switched off on the server: no state can change any more, and needs_reauth in
  // particular must not ask for a sign-in that cannot help. A meeting that was
  // already collected (`ready`) still goes on to its review.
  const off = status?.enabled === false && status.state !== 'ready';
  const state = off ? undefined : status?.state;

  // Before the scheduled end we are waiting for the meeting; after it we are
  // waiting for Microsoft to publish. Saying "Venter på mødet…" for both told
  // the user their finished meeting had not started yet.
  // Re-evaluated on every status poll, so it flips on its own without a reload.
  const meetingOver =
    status?.scheduledEnd != null && Date.parse(status.scheduledEnd) <= Date.now();
  const stopped = off || state === 'ready' || state === 'failed' || state === 'needs_reauth';

  useEffect(() => {
    if (stopped) return;
    const id = setInterval(() => { void poll(false); }, intervalMs);
    return () => clearInterval(id);
  }, [poll, intervalMs, stopped]);

  // Puts the ready-but-gone row back into a pollable state, then polls it with
  // force, exactly as "Prøv igen" does for a failed one.
  const recollect = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch(`/api/teams/meetings/${meetingId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'recollect' }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error === 'window_closed'
          ? 'Transskriptionen kan ikke længere hentes automatisk fra Teams.'
          : 'Kunne ikke hente transskriptionen igen. Prøv igen om lidt.');
        return;
      }
    } catch (err) {
      console.warn('[TeamsMeetingScreen] hent igen fejlede:', err);
      setError('Kunne ikke hente transskriptionen igen. Prøv igen om lidt.');
      return;
    } finally {
      setChecking(false);
    }
    setError(null);
    void poll(true);
  }, [meetingId, poll]);

  // Stay on the screen when the server could not be told: leaving would strand a
  // meeting that keeps being collected, with nothing left to press.
  const disarm = useCallback(async () => {
    try {
      await deleteMeetingAndUnregister(meetingId);
    } catch (err) {
      console.error('[TeamsMeetingScreen] kunne ikke slå Memoctopus fra:', err);
      setError('Kunne ikke slå Memoctopus fra. Prøv igen.');
      return;
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
        {status?.armed && !off && (
          <span
            data-testid="armed-badge"
            style={{
              padding: '6px 12px', borderRadius: 999, fontSize: 12,
              background: 'var(--keep, #e7f5ec)', color: 'var(--ink)',
              border: '1px solid var(--line-2)',
            }}
          >
            {status.armResult === 'armed_in_progress'
              ? 'Start transskription i Teams'
              : 'Memoctopus er slået til'}
          </span>
        )}
      </div>

      <div style={{ marginTop: 28, borderTop: '1px solid var(--line)', paddingTop: 24 }}>
        {off && (
          <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6 }}>
            Teams-integrationen er ikke slået til, så Memoctopus henter ikke referatet fra dette møde.
            Kontakt jeres IT-administrator.
          </p>
        )}

        {state === 'awaiting_teams' && status?.armed && status.armResult !== 'armed_in_progress' && (
          <>
            <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6 }}>
              {meetingOver
                ? 'Mødet er slut. Memoctopus henter transskriptionen fra Teams, så snart Microsoft frigiver den — det tager typisk et par minutter, men kan tage længere.'
                : 'Mødet optages og transskriberes automatisk. Referatet er klar automatisk et par minutter efter mødet.'}
            </p>
            <p style={{ marginTop: 10, fontSize: 13.5, color: 'var(--muted)' }}>
              {meetingOver ? 'Henter fra Teams…' : 'Venter på mødet…'}
            </p>
            {!meetingOver && (
              <p style={{ marginTop: 10, fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
                Memoctopus venter til mødet er planlagt til at slutte. Sluttede I før tid,
                så tryk <strong>Mødet er slut – hent nu</strong>, så henter vi den med det samme.
              </p>
            )}
          </>
        )}

        {state === 'awaiting_teams' && status?.armResult === 'armed_in_progress' && (
          <>
            <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6 }}>
              Mødet er allerede i gang. Teams starter kun transskription af sig selv på et møde, der
              endnu ikke er begyndt, så du skal starte den i mødet:{' '}
              <strong>Flere handlinger → Optag og transskriber → Start transskription</strong>.
            </p>
            <p style={{ marginTop: 10, fontSize: 13.5, color: 'var(--muted)' }}>
              Memoctopus henter referatet automatisk et par minutter efter mødet. Planlægger du mødet
              i kalenderen i stedet og indsætter linket, inden mødet begynder, sker det hele af sig selv.
            </p>
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

        {state === 'ready' && !copyGone && (
          <p style={{ margin: 0, fontSize: 15 }}>Transskriptionen er hentet. Åbner gennemgangen…</p>
        )}

        {state === 'ready' && copyGone && (
          <>
            <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6 }}>
              Transskriptionen ligger ikke længere på serveren, fordi den ikke blev åbnet i tide.
              Teams har stadig mødet, så du kan hente den igen.
            </p>
            <button
              type="button"
              onClick={() => { void recollect(); }}
              disabled={checking}
              style={{
                marginTop: 14, padding: '9px 16px', borderRadius: 8, fontSize: 13,
                background: 'var(--ink)', color: 'var(--bg)', border: 'none',
                cursor: checking ? 'default' : 'pointer',
              }}
            >
              Hent igen
            </button>
          </>
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
        {!off && (
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
            {state === 'failed'
              ? 'Prøv igen'
              : state === 'awaiting_teams' && !meetingOver
                ? 'Mødet er slut – hent nu'
                : 'Tjek nu'}
          </button>
        )}
        <button
          type="button"
          onClick={() => { void disarm(); }}
          style={{
            padding: '9px 16px', borderRadius: 8, fontSize: 13,
            border: '1px solid var(--line-2)', background: 'transparent',
            color: 'var(--muted)', cursor: 'pointer',
          }}
        >
          {status?.state === 'failed' ? 'Slet' : 'Slå Memoctopus fra'}
        </button>
      </div>
    </div>
  );
}
