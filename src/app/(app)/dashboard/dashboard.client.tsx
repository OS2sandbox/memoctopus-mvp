'use client';

import React, { useState, useEffect, KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useIsMobile } from '@/lib/use-is-mobile';
import { createMeeting, getAllMeetings } from '@/lib/storage';
import { deleteMeetingAndUnregister } from '@/lib/teams/client-delete';
import { setPendingUploadFile } from '@/lib/pending-upload';
import { ErrorBanner } from '@/components/ui/error-banner';
import { armErrorMessage } from '@/components/dashboard/arm-error-message';
import { signIn } from '@/lib/auth-client';

interface TeamsStatus {
  /** False when the server has TEAMS_GRAPH_ENABLED off. Absent means on. */
  enabled?: boolean;
  microsoftLinked: boolean;
  scopesOk: boolean;
  missing: string[];
}

export default function OptaqPage() {
  const router = useRouter();
  const isMobile = useIsMobile();
  const [title, setTitle] = useState('');
  const [participants, setParticipants] = useState<string[]>([]);
  const [adding, setAdding] = useState('');
  const [loading, setLoading] = useState(false);
  const [meetingLink, setMeetingLink] = useState('');
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkError, setLinkError] = useState('');
  const [recordError, setRecordError] = useState('');
  const [meetingCount, setMeetingCount] = useState<number | null>(null);
  const [teamsStatus, setTeamsStatus] = useState<TeamsStatus | null>(null);

  useEffect(() => {
    getAllMeetings()
      .then((meetings) => setMeetingCount(meetings.length))
      .catch((err) => { console.warn('[dashboard] getAllMeetings failed:', err); });
  }, []);

  // Whether the Teams section can work at all is a server-side fact (is there a
  // Microsoft account, and does its stored scope cover Graph), so it is fetched
  // rather than derived from the session on the client.
  useEffect(() => {
    fetch('/api/teams/status')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: TeamsStatus | null) => { if (data) setTeamsStatus(data); })
      .catch((err) => { console.warn('[dashboard] teams status failed:', err); });
  }, []);

  // Off on the server: the Graph scopes are never requested, so the link box could
  // only fail and every hint below would point at a sign-in that cannot help.
  const teamsOff = teamsStatus?.enabled === false;

  function reconsent() {
    void signIn.social({ provider: 'microsoft', callbackURL: '/dashboard' });
  }

  function handleKeyDown(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement).tagName;
    if (/input|textarea/i.test(tag)) return;
    // Ignore browser/OS shortcuts so a hard refresh (Cmd/Ctrl+Shift+R) isn't read
    // as the "R = record" shortcut and dropped into a recording.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); startRecording(); }
    if (e.key === 'u' || e.key === 'U') document.getElementById('upload-input')?.click();
  }

  async function startRecording() {
    if (loading) return;
    setLoading(true);
    setRecordError('');
    try {
      const meetingTitle = title.trim() || `Møde · ${new Intl.DateTimeFormat('da', { day: 'numeric', month: 'long' }).format(new Date())}`;
      const meeting = await createMeeting({
        title: meetingTitle,
        participants: participants.length > 0 ? participants : undefined,
        source: 'local',
        status: 'recording',
      });
      router.push(`/meeting/${meeting.id}?autostart=1`);
    } catch (err) {
      console.error('[dashboard] startRecording failed:', err);
      setRecordError('Noget gik galt. Prøv igen.');
      setLoading(false);
    }
  }

  // The local meeting is created first because its id is what registers the
  // meeting server-side. If Graph rejects the link, the orphan is removed again
  // so the Arkiv never fills with meetings that can never produce a referat.
  async function joinMeeting(link: string) {
    if (linkLoading) return;
    setLinkLoading(true);
    setLinkError('');
    let localId: string | null = null;
    try {
      const dateStr = new Intl.DateTimeFormat('da', { day: 'numeric', month: 'long' }).format(new Date());
      const meeting = await createMeeting({
        title: `Teams-møde · ${dateStr}`,
        source: 'teams',
        graphManaged: true,
        meetingUrl: link,
        status: 'awaiting_teams',
      });
      localId = meeting.id;

      const res = await fetch('/api/teams/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meetingId: meeting.id, joinUrl: link }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setLinkError(armErrorMessage(res.status, (body as { error?: string }).error));
        await deleteMeetingAndUnregister(meeting.id).catch(() => {});
        setLinkLoading(false);
        return;
      }
      router.push(`/meeting/${meeting.id}`);
    } catch {
      if (localId) await deleteMeetingAndUnregister(localId).catch(() => {});
      setLinkError('Noget gik galt. Prøv igen.');
      setLinkLoading(false);
    }
  }

  function addParticipant() {
    const v = adding.trim();
    if (v) { setParticipants([...participants, v]); setAdding(''); }
  }

  return (
    <div
      style={{ minHeight: 'calc(100vh - 56px)', padding: isMobile ? '40px 20px 64px' : '64px 48px 96px', outline: 'none' }}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <div style={{ maxWidth: 1240, margin: '0 auto' }}>

        {/* Hero */}
        <div style={{ textAlign: 'center' }}>
          <div style={{
            display: 'inline-flex', flexWrap: 'wrap', justifyContent: 'center',
            gap: isMobile ? 10 : 20, marginBottom: isMobile ? 24 : 32,
            fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--accent)',
            letterSpacing: 0.8,
          }}>
            <span>OPEN SOURCE</span>
            <span style={{ color: 'var(--muted-2)' }}>·</span>
            <span>LOKAL BEHANDLING</span>
            <span style={{ color: 'var(--muted-2)' }}>·</span>
            <span>DIGITAL SUVERÆNITET</span>
          </div>
          <h1 style={{
            fontWeight: 300, fontSize: isMobile ? 40 : 64, lineHeight: 1.04,
            letterSpacing: '-0.03em', margin: 0, textWrap: 'balance' as const,
          }}>
            Møde til <em style={{ fontStyle: 'italic', color: 'var(--accent)', fontWeight: 300 }}>referat</em>.
          </h1>
          <div style={{
            fontSize: isMobile ? 15 : 17, color: 'var(--ink-2)', lineHeight: 1.6,
            maxWidth: 520, margin: '18px auto 0',
          }}>
            Dansk AI — kørt lokalt, frigivet åbent.<br />
            Ingen data forlader din maskine.
          </div>
        </div>

        {/* Teams — access hints. A Teams meeting is registered by pasting its
            mødelink into the box above; nothing is listed from the calendar. */}
        <div style={{ maxWidth: 560, margin: isMobile ? '36px auto 0' : '56px auto 0' }}>
          {teamsStatus && !teamsOff && !teamsStatus.microsoftLinked && (
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted)', textAlign: 'center' }}>
              Teams-referater kræver, at du logger ind med Microsoft.
            </div>
          )}

          {teamsStatus && !teamsOff && teamsStatus.microsoftLinked && !teamsStatus.scopesOk && (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted)' }}>
                Memoctopus mangler adgang til dine Teams-møder.
              </div>
              <button
                type="button"
                onClick={reconsent}
                style={{
                  marginTop: 10, padding: '8px 16px', borderRadius: 999, fontSize: 12.5,
                  border: '1px solid var(--line-2)', background: 'transparent',
                  color: 'var(--ink)', cursor: 'pointer',
                }}
              >
                Giv adgang igen
              </button>
            </div>
          )}
        </div>

        {/* 3-column grid */}
        <div style={{
          marginTop: isMobile ? 40 : 72,
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr' : '1fr auto 1fr',
          gap: isMobile ? 40 : 56,
          alignItems: 'center',
        }}>

          {/* LEFT — optional meeting details */}
          <div style={{ opacity: 0.95, order: isMobile ? 2 : 0 }}>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)',
              letterSpacing: 0.4, display: 'flex', justifyContent: 'space-between',
            }}>
              <span>mødedetaljer</span>
              <span style={{ color: 'var(--muted-2)' }}>valgfrit · kan tilføjes senere</span>
            </div>

            <div style={{ marginTop: 18, paddingBottom: 8, borderBottom: '1px solid var(--line)' }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted-2)', marginBottom: 8, letterSpacing: 0.4 }}>
                mødets navn
              </div>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') startRecording(); }}
                placeholder="Navngiv mødet…"
                style={{
                  width: '100%', fontSize: 19, color: 'var(--ink)',
                  fontWeight: 300, padding: '4px 0',
                  background: 'transparent', border: 'none', outline: 'none',
                }}
              />
            </div>

            <div style={{ marginTop: 24 }}>
              <div style={{
                fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted-2)',
                marginBottom: 8, letterSpacing: 0.4,
              }}>deltagere</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {participants.map((p, i) => (
                  <span key={i} style={{
                    fontFamily: 'var(--mono)', fontSize: 12,
                    padding: '4px 10px', borderRadius: 999,
                    border: '1px solid var(--line-2)', background: 'var(--bg-2)',
                    color: 'var(--ink-2)', display: 'inline-flex', alignItems: 'center', gap: 6,
                  }}>
                    {p}
                    <button
                      type="button"
                      aria-label={`Fjern ${p}`}
                      onClick={() => setParticipants(participants.filter((_, j) => j !== i))}
                      style={{
                        color: 'var(--muted-2)', cursor: 'pointer',
                        background: 'none', border: 'none', padding: 0, font: 'inherit', lineHeight: 1,
                      }}>×</button>
                  </span>
                ))}
                <input
                  value={adding}
                  onChange={(e) => setAdding(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addParticipant(); } }}
                  placeholder="+ tilføj"
                  style={{
                    fontFamily: 'var(--mono)', fontSize: 12,
                    padding: '4px 10px', borderRadius: 999,
                    border: '1px dashed var(--line-2)',
                    color: 'var(--ink-2)', width: 90,
                    background: 'transparent', outline: 'none',
                  }}
                />
              </div>
            </div>
          </div>

          {/* CENTER — record button + meeting link input */}
          <div style={{ textAlign: 'center', order: isMobile ? 1 : 0 }}>
            <button
              onClick={startRecording}
              disabled={loading}
              style={{
                width: 200, height: 200, borderRadius: 999,
                margin: '0 auto',
                background: loading ? 'var(--ink-2)' : 'var(--ink)',
                color: 'var(--bg)',
                border: 'none', cursor: loading ? 'not-allowed' : 'pointer',
                display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', gap: 14,
                boxShadow: '0 1px 0 var(--line-2)',
                transition: 'background 150ms',
              }}
            >
              <span style={{ width: 22, height: 22, borderRadius: 999, background: 'var(--bg)' }} />
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 13,
                letterSpacing: 0.6, opacity: 0.85,
              }}>optag</span>
            </button>

            {recordError && (
              <div style={{ marginTop: 14, maxWidth: 300, margin: '14px auto 0' }}>
                <ErrorBanner message={recordError} onRetry={startRecording} />
              </div>
            )}

            {/* Teams meeting link input */}
            {!teamsOff && (
              <div style={{ marginTop: 30 }}>
                <div style={{
                  fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted-2)',
                  letterSpacing: 0.4, marginBottom: 10,
                }}>eller deltag i et møde</div>
                <div
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    width: 300, margin: '0 auto',
                    border: '1px solid var(--line-2)', borderRadius: 999,
                    background: 'var(--surface)', padding: '4px 4px 4px 14px',
                    transition: 'border-color 120ms',
                  }}
                  onFocusCapture={(e) => (e.currentTarget.style.borderColor = 'var(--accent)')}
                  onBlurCapture={(e) => (e.currentTarget.style.borderColor = 'var(--line-2)')}
                >
                  <input
                    value={meetingLink}
                    onChange={(e) => { setMeetingLink(e.target.value); if (linkError) setLinkError(''); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && meetingLink.trim()) {
                        e.preventDefault();
                        joinMeeting(meetingLink.trim());
                      }
                    }}
                    placeholder="Indsæt mødelink…"
                    style={{
                      flex: 1, fontFamily: 'var(--mono)', fontSize: 12.5,
                      color: 'var(--ink)', padding: '7px 0',
                      background: 'transparent', border: 'none', outline: 'none',
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => meetingLink.trim() && joinMeeting(meetingLink.trim())}
                    disabled={!meetingLink.trim() || linkLoading}
                    style={{
                      width: 30, height: 30, borderRadius: 999, flexShrink: 0,
                      border: 'none',
                      background: meetingLink.trim() && !linkLoading ? 'var(--accent)' : 'var(--sunk)',
                      color: meetingLink.trim() && !linkLoading ? '#fff' : 'var(--muted-2)',
                      cursor: meetingLink.trim() && !linkLoading ? 'pointer' : 'default',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 14, transition: 'background 120ms',
                    }}
                  >
                    {linkLoading ? '…' : '→'}
                  </button>
                </div>
                {linkError && (
                  <div style={{
                    marginTop: 8, fontFamily: 'var(--mono)', fontSize: 11,
                    color: 'var(--error, #e05252)', textAlign: 'center',
                  }}>{linkError}</div>
                )}
              </div>
            )}

            <div style={{
              marginTop: 18, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted-2)',
            }}>
              eller{' '}
              <label
                htmlFor="upload-input"
                style={{
                  color: 'var(--ink-2)', textDecoration: 'underline',
                  textDecorationColor: 'var(--line-2)', textUnderlineOffset: 3,
                  cursor: 'pointer',
                }}
              >
                upload lydfil →
              </label>
              <input
                id="upload-input"
                type="file"
                accept="audio/*,video/*"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    setPendingUploadFile(file);
                    router.push('/meeting/new');
                    e.target.value = '';
                  }
                }}
              />
            </div>
          </div>

          {/* RIGHT — status + compliance */}
          <div style={{ opacity: 0.95, order: isMobile ? 3 : 0 }}>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)',
              letterSpacing: 0.4,
            }}>status</div>

            <div style={{
              marginTop: 14, paddingBottom: 14,
              borderBottom: '1px solid var(--line)',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <span style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--keep)', flexShrink: 0 }} />
              <div>
                <div style={{ fontSize: 13.5, color: 'var(--ink)' }}>Hviske · dansk tale-til-tekst</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--muted)', marginTop: 2 }}>
                  lokal behandling · åben kildekode
                </div>
              </div>
            </div>

            <div style={{ marginTop: 18 }}>
              <div style={{
                fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted-2)',
                marginBottom: 8, letterSpacing: 0.4,
              }}>mikrofon</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.6 }}>
                der anmodes om adgang, når du starter en optagelse
              </div>
            </div>

            <div style={{ marginTop: 24 }}>
              <div style={{
                fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted-2)',
                marginBottom: 10, letterSpacing: 0.4,
              }}>§ databehandling</div>
              <div style={{
                fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted)',
                lineHeight: 1.8, letterSpacing: 0.2,
              }}>
                lyden gemmes lokalt på din enhed<br />
                slettes automatisk når referatet er genereret<br />
                personoplysninger fjernes inden referat
              </div>
            </div>
          </div>
        </div>

        {/* Footer hint */}
        <div style={{
          marginTop: isMobile ? 56 : 96, paddingTop: 24, borderTop: '1px solid var(--line)',
          display: 'flex', justifyContent: 'flex-end',
          fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted)',
        }}>
          {meetingCount != null && meetingCount > 0 ? (
            <Link
              href="/arkiv"
              style={{
                color: 'var(--ink-2)', textDecoration: 'underline',
                textDecorationColor: 'var(--line-2)', textUnderlineOffset: 3,
              }}
            >
              se {meetingCount} tidligere møder i arkivet →
            </Link>
          ) : (
            <span>ingen tidligere møder</span>
          )}
        </div>
      </div>
    </div>
  );
}
