'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useIsMobile } from '@/lib/use-is-mobile';

interface MeetingBotScreenProps {
  meetingId: string;
  meetingUrl: string;
}

type BotStatus = 'forbinder' | 'optager' | 'pause' | 'processing' | 'error' | 'cancelled';

function pollBackoffMs(attempt: number): number {
  return Math.min(2000 * 2 ** attempt, 30_000);
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export function MeetingBotScreen({ meetingId, meetingUrl }: MeetingBotScreenProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isMobile = useIsMobile();

  const [status, setStatus] = useState<BotStatus>('forbinder');
  const [elapsed, setElapsed] = useState(0);
  const [participants, setParticipants] = useState<string[]>([]);
  const [controlLoading, setControlLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerStartMsRef = useRef<number>(0);
  const statusRef = useRef<BotStatus>('forbinder');
  const participantsRef = useRef<string>('[]');
  const consecutiveFailsRef = useRef(0);
  const nextPollAtRef = useRef(0);
  statusRef.current = status;

  const stopTimer = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }, []);

  const startTimer = useCallback(() => {
    stopTimer();
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - timerStartMsRef.current) / 1000));
    }, 500);
  }, [stopTimer]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const pollStatus = useCallback(async () => {
    if (Date.now() < nextPollAtRef.current) return;
    try {
      const res = await fetch(`/api/bot/status/${meetingId}`);
      if (!res.ok) {
        consecutiveFailsRef.current++;
        nextPollAtRef.current = Date.now() + pollBackoffMs(consecutiveFailsRef.current);
        return;
      }
      consecutiveFailsRef.current = 0;
      nextPollAtRef.current = 0;
      const data = await res.json();
      const newStatus: BotStatus = data.status as BotStatus;

      // Terminal states — handle first before any status update
      if (data.meetingStatus === 'cancelled') {
        stopPolling();
        stopTimer();
        setStatus('cancelled');
        return;
      }
      if (data.meetingStatus === 'review') {
        stopPolling();
        stopTimer();
        router.push(`/meeting/${meetingId}/review`);
        return;
      }

      const newParticipantsJson = JSON.stringify(data.participants ?? []);
      if (newParticipantsJson !== participantsRef.current) {
        participantsRef.current = newParticipantsJson;
        setParticipants(data.participants ?? []);
      }

      // Sync timer start reference from server on every recording poll so the
      // Date.now()-based interval stays aligned regardless of JS timer drift.
      if (newStatus === 'optager' && data.elapsed != null) {
        const serverElapsed = data.elapsed as number;
        timerStartMsRef.current = Date.now() - serverElapsed * 1000;
        setElapsed(serverElapsed);
      }

      if (newStatus !== statusRef.current) {
        if (newStatus === 'optager') {
          timerStartMsRef.current = Date.now() - ((data.elapsed as number | null) ?? 0) * 1000;
          startTimer();
        } else if (newStatus === 'pause') {
          stopTimer();
        } else if (newStatus === 'processing') {
          stopTimer();
        }
        setStatus(newStatus);
      }
    } catch {
      consecutiveFailsRef.current++;
      nextPollAtRef.current = Date.now() + pollBackoffMs(consecutiveFailsRef.current);
    }
  }, [meetingId, startTimer, stopTimer, stopPolling, router]);

  // Start bot session on mount (only when ?join=1).
  // AbortController ensures only one request survives in React Strict Mode's
  // double-mount cycle — the cleanup cancels the first, the second completes.
  useEffect(() => {
    const shouldJoin = searchParams.get('join') === '1';
    if (!shouldJoin) return;

    const controller = new AbortController();
    fetch('/api/bot/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meetingId }),
      signal: controller.signal,
    }).then(async (res) => {
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setStatus('error');
        setErrorMessage(body.error ?? 'Kunne ikke starte bot-session');
      }
    }).catch((err: unknown) => {
      if (err instanceof Error && err.name !== 'AbortError') setStatus('error');
    });
    return () => controller.abort();
  }, [meetingId, searchParams]);

  // Begin polling as soon as the component mounts
  useEffect(() => {
    pollStatus();
    pollRef.current = setInterval(pollStatus, 2000);
    return () => {
      stopPolling();
      stopTimer();
    };
  }, [pollStatus, stopPolling, stopTimer]);

  function sendControl(action: string) {
    return fetch(`/api/bot/control/${meetingId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
  }

  async function handlePauseResume() {
    if (controlLoading) return;
    const action = status === 'optager' ? 'pause' : 'resume';
    setControlLoading(true);
    try {
      await sendControl(action);
      if (action === 'pause') { stopTimer(); setStatus('pause'); }
      else {
        timerStartMsRef.current = Date.now() - elapsed * 1000;
        startTimer();
        setStatus('optager');
      }
    } finally {
      setControlLoading(false);
    }
  }

  async function handleStop() {
    if (controlLoading) return;
    setControlLoading(true);
    try {
      await sendControl('stop');
      stopTimer();
      setStatus('processing');
    } finally {
      setControlLoading(false);
    }
  }

  async function handleAbort() {
    if (controlLoading) return;
    setControlLoading(true);
    stopPolling();
    stopTimer();
    await sendControl('abort').catch(() => {});
    router.push('/dashboard');
  }

  const isConnecting = status === 'forbinder';
  const isPaused = status === 'pause';
  const isProcessing = status === 'processing';
  const isRecording = status === 'optager';
  const isCancelled = status === 'cancelled';

  const statusMeta = {
    forbinder: { dot: 'var(--accent)', label: 'forbinder til mødet…', pulse: true },
    optager:   { dot: 'var(--kill)',   label: 'optager · i mødet',    pulse: true },
    pause:     { dot: 'var(--muted)',  label: 'sat på pause',         pulse: false },
    processing:{ dot: 'var(--accent)', label: 'behandler optagelse…', pulse: true },
    error:     { dot: 'var(--kill)',   label: 'fejl ved forbindelse',  pulse: false },
    cancelled: { dot: 'var(--muted)',  label: 'møde afbrudt',         pulse: false },
  }[status];

  const noticeKickerMap: Record<BotStatus, string> = {
    cancelled: 'AFBRUDT',
    forbinder: 'RINGER OP',
    pause: 'PÅ PAUSE',
    processing: 'BEHANDLER',
    error: 'FEJL',
    optager: 'OPTAGER MØDET',
  };
  const noticeKicker = noticeKickerMap[status];

  const noticeBodyMap: Partial<Record<BotStatus, string>> = {
    cancelled: 'Mødet blev afbrudt og ingen optagelse blev gemt.',
    forbinder: 'Memoctopus ringer op til mødet og venter på at blive lukket ind…',
    pause: 'Optagelsen er sat på pause. Tryk fortsæt for at optage igen.',
    processing: 'Mødet er slut. Transskription og referat er ved at blive lavet — det tager et øjeblik…',
    optager: 'Memoctopus optager mødet. Når du stopper, laves transskription og referat automatisk.',
  };
  const noticeBody = status === 'error'
    ? (errorMessage ?? 'Der opstod en fejl ved forbindelsen til mødet.')
    : (noticeBodyMap[status] ?? '');

  const storageEstimate = ((elapsed / 60) * 1.6).toFixed(1);

  const truncatedUrl = meetingUrl.length > 60
    ? `${meetingUrl.slice(0, 57)}…`
    : meetingUrl;

  return (
    <div style={{
      minHeight: 'calc(100vh - 56px)',
      padding: isMobile ? '32px 20px 64px' : '56px 48px 96px',
    }}>
      <div style={{ maxWidth: 860, margin: '0 auto' }}>

        {/* Top row — back + meeting link chip */}
        <div style={{
          display: 'flex',
          alignItems: isMobile ? 'flex-start' : 'center',
          flexDirection: isMobile ? 'column' : 'row',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 40,
        }}>
          {!isRecording && !isPaused && (
            <button
              onClick={handleAbort}
              disabled={controlLoading}
              style={{
                fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--ink-2)',
                background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                textDecoration: 'underline', textDecorationColor: 'var(--line-2)',
                textUnderlineOffset: 3,
              }}
            >
              ← afbryd
            </button>
          )}
          {(isRecording || isPaused) && (
            <div style={{ width: 1 }} />
          )}
          {meetingUrl && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              maxWidth: isMobile ? '100%' : 420,
              fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted)',
              border: '1px solid var(--line)', borderRadius: 999, padding: '5px 14px',
              overflow: 'hidden',
            }}>
              <span style={{ color: 'var(--muted-2)', flexShrink: 0 }}>↳</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {truncatedUrl}
              </span>
            </span>
          )}
        </div>

        {/* Header — status eyebrow + timer + signal meter + storage */}
        <div style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: isMobile ? 16 : 28,
          flexWrap: isMobile ? 'wrap' : 'nowrap',
        }}>
          {/* Status + timer */}
          <div>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', letterSpacing: 0.4,
            }}>
              <span style={{
                width: 7, height: 7, borderRadius: 999,
                background: statusMeta.dot, flexShrink: 0,
                animation: statusMeta.pulse ? 'botPulse 1.4s ease-in-out infinite' : 'none',
              }} />
              {statusMeta.label}
            </div>
            <div style={{
              fontFamily: 'var(--mono)',
              fontSize: isMobile ? 40 : 60,
              fontWeight: 500,
              letterSpacing: '-0.04em',
              color: isConnecting ? 'var(--muted-2)' : 'var(--ink)',
              fontVariantNumeric: 'tabular-nums',
              lineHeight: 1,
              marginTop: 10,
            }}>
              {isConnecting ? '00:00' : fmtTime(elapsed)}
            </div>
          </div>


          {/* Storage estimate */}
          <div style={{ marginLeft: isMobile ? 0 : 'auto', textAlign: 'right' }}>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)',
              letterSpacing: 0.4, marginBottom: 6,
            }}>lagring</div>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--ink-2)',
            }}>
              {storageEstimate} MB · webm/opus
            </div>
          </div>
        </div>

        {/* Body — notice card + participants */}
        <div style={{
          marginTop: 32,
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr' : '1fr 300px',
          gap: 32,
        }}>
          {/* Notice card */}
          <div style={{
            border: '1px solid var(--line-2)', borderRadius: 'var(--radius)',
            background: 'var(--surface)', padding: 28,
            display: 'flex', flexDirection: 'column', justifyContent: 'center',
          }}>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--accent)',
              letterSpacing: 0.5, marginBottom: 14,
            }}>
              {noticeKicker}
            </div>
            <div style={{
              fontSize: 19, fontWeight: 300, color: 'var(--ink)',
              lineHeight: 1.5, letterSpacing: '-0.01em',
            }}>
              {noticeBody}
            </div>
            <div style={{
              marginTop: 22, paddingTop: 18, borderTop: '1px solid var(--line)',
              fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.8,
            }}>
              lyden gemmes lokalt på din enhed<br />
              referatet laves når mødet er slut<br />
              lyden slettes automatisk efter referatet
            </div>
          </div>

          {/* Participants panel */}
          <div>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)',
              letterSpacing: 0.4, marginBottom: 10,
            }}>
              registreret fra mødet · {participants.length + 1}
            </div>

            {/* Bot row */}
            <div style={{
              padding: '9px 0', borderTop: '1px solid var(--line)',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <span style={{
                width: 24, height: 24, borderRadius: 999,
                background: 'var(--ink)', color: 'var(--bg)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: 'var(--mono)', fontSize: 9, flexShrink: 0,
              }}>M</span>
              <span style={{ flex: 1, fontSize: 13.5, color: 'var(--ink)' }}>Memoctopus</span>
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 10,
                color: isConnecting ? 'var(--muted)' : isPaused ? 'var(--muted)' : 'var(--kill)',
              }}>
                {isConnecting ? 'venter' : isPaused ? 'pause' : isProcessing ? 'færdig' : 'optager'}
              </span>
            </div>

            {/* Detected participant rows */}
            {participants.map((p) => (
              <div key={p} style={{
                padding: '9px 0', borderTop: '1px solid var(--line)',
                display: 'flex', alignItems: 'center', gap: 10,
              }}>
                <span style={{
                  width: 24, height: 24, borderRadius: 999,
                  border: '1px solid var(--line-2)', background: 'var(--bg-2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-2)', flexShrink: 0,
                }}>{p[0]?.toUpperCase() ?? '?'}</span>
                <span style={{ flex: 1, fontSize: 13.5, color: 'var(--ink-2)' }}>{p}</span>
                <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--keep)', flexShrink: 0 }} />
              </div>
            ))}

            {/* Footer line */}
            <div style={{
              borderTop: '1px solid var(--line)', paddingTop: 8,
              fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--muted)',
              display: 'flex', alignItems: 'center', gap: 7,
            }}>
              <span style={{
                width: 5, height: 5, borderRadius: 999,
                background: 'var(--muted-2)', flexShrink: 0,
                animation: isRecording ? 'botPulse 1.4s ease-in-out infinite' : 'none',
              }} />
              {isConnecting
                ? 'afventer forbindelse…'
                : isProcessing
                ? 'alle talere registreret'
                : isRecording
                ? 'lytter efter talere…'
                : 'optagelse sat på pause'}
            </div>
          </div>
        </div>

        {/* Controls */}
        <div style={{
          marginTop: 36, paddingTop: 22, borderTop: '1px solid var(--line)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16,
        }}>
          {isCancelled && (
            <button
              onClick={() => router.push('/')}
              style={{
                fontSize: 13.5, fontWeight: 500, padding: '11px 18px',
                borderRadius: 'var(--radius)', border: '1px solid var(--line-2)',
                background: 'var(--ink)', color: 'var(--bg)',
                cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: 8, lineHeight: 1,
              }}
            >
              ← gå til forsiden
            </button>
          )}

          {isConnecting && !isCancelled && (
            <button
              onClick={handleAbort}
              disabled={controlLoading}
              style={{
                fontSize: 13.5, fontWeight: 500, padding: '8px 14px',
                borderRadius: 'var(--radius)', border: '1px solid var(--line-2)',
                background: 'transparent', cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: 8, lineHeight: 1,
                opacity: controlLoading ? 0.6 : 1,
              }}
            >
              afbryd opkald
            </button>
          )}

          {isProcessing && (
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <span style={{
                width: 7, height: 7, borderRadius: 999, background: 'var(--accent)',
                animation: 'botPulse 1.4s ease-in-out infinite',
              }} />
              Transskription i gang…
            </div>
          )}

          {(isRecording || isPaused) && (
            <>
              {/* Pause / Play circle button */}
              <button
                onClick={handlePauseResume}
                disabled={controlLoading}
                title={isPaused ? 'Fortsæt optagelse' : 'Pause optagelse'}
                style={{
                  width: 56, height: 56, borderRadius: 999,
                  background: 'var(--ink)', color: 'var(--bg)',
                  border: 'none', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  opacity: controlLoading ? 0.6 : 1,
                  flexShrink: 0,
                }}
              >
                {isPaused ? (
                  <span style={{
                    width: 0, height: 0,
                    borderTop: '6px solid transparent',
                    borderBottom: '6px solid transparent',
                    borderLeft: '10px solid var(--bg)',
                    marginLeft: 2,
                  }} />
                ) : (
                  <span style={{ display: 'inline-flex', gap: 3 }}>
                    <span style={{ width: 4, height: 14, background: 'var(--bg)' }} />
                    <span style={{ width: 4, height: 14, background: 'var(--bg)' }} />
                  </span>
                )}
              </button>

              {/* Stop & afslut solid button */}
              <button
                onClick={handleStop}
                disabled={controlLoading}
                style={{
                  fontSize: 13.5, fontWeight: 500, padding: '11px 18px',
                  borderRadius: 'var(--radius)', border: '1px solid var(--line-2)',
                  background: 'var(--ink)', color: 'var(--bg)',
                  cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 8, lineHeight: 1,
                  opacity: controlLoading ? 0.6 : 1,
                }}
              >
                Stop & afslut →
              </button>
            </>
          )}
        </div>

        {/* Hint line */}
        <div style={{
          marginTop: 16, textAlign: 'center',
          fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted-2)',
        }}>
          {isCancelled
            ? ''
            : isConnecting
            ? 'forbinder…'
            : isProcessing
            ? 'navigerer til gennemgang når transskriptionen er klar…'
            : 'optagelsen stopper automatisk når mødet slutter'}
        </div>
      </div>

      <style>{`
        @keyframes botPulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}
