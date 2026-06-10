'use client';

import React, { useState, useEffect, KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useIsMobile } from '@/lib/use-is-mobile';
import { setPendingUploadFile } from '@/lib/pending-upload';

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
  const [meetingCount, setMeetingCount] = useState<number | null>(null);

  useEffect(() => {
    fetch('/api/meetings?count=1')
      .then((r) => r.json())
      .then((d) => setMeetingCount(d.count ?? null))
      .catch(() => {});
  }, []);

  function handleKeyDown(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement).tagName;
    if (/input|textarea/i.test(tag)) return;
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); startRecording(); }
    if (e.key === 'u' || e.key === 'U') document.getElementById('upload-input')?.click();
  }

  async function startRecording() {
    if (loading) return;
    setLoading(true);
    try {
      const body: Record<string, unknown> = {
        title: title.trim() || `Møde · ${new Intl.DateTimeFormat('da', { day: 'numeric', month: 'long' }).format(new Date())}`,
      };
      if (participants.length > 0) body.participants = participants;
      const res = await fetch('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.id) router.push(`/meeting/${data.id}?autostart=1`);
    } catch {
      setLoading(false);
    }
  }

  async function joinMeeting(link: string) {
    if (linkLoading) return;
    setLinkLoading(true);
    setLinkError('');
    try {
      const dateStr = new Intl.DateTimeFormat('da', { day: 'numeric', month: 'long' }).format(new Date());
      const res = await fetch('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'teams',
          meetingUrl: link,
          title: `Teams-møde · ${dateStr}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLinkError(res.status === 400
          ? 'Ugyldigt mødelink. Indsæt et gyldigt Teams-link.'
          : 'Noget gik galt. Prøv igen.');
        setLinkLoading(false);
        return;
      }
      if (!data.id) {
        setLinkError('Noget gik galt. Prøv igen.');
        setLinkLoading(false);
        return;
      }
      router.push(`/meeting/${data.id}?join=1`);
    } catch {
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
            {/* Eyebrow */}
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)',
              letterSpacing: 0.4, display: 'flex', justifyContent: 'space-between',
            }}>
              <span>mødedetaljer</span>
              <span style={{ color: 'var(--muted-2)' }}>valgfrit · kan tilføjes senere</span>
            </div>

            {/* Title input */}
            <div style={{ marginTop: 18, paddingBottom: 8, borderBottom: '1px solid var(--line)' }}>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') startRecording(); }}
                placeholder="Hvad handler mødet om?"
                style={{
                  width: '100%', fontSize: 19, color: 'var(--ink)',
                  fontWeight: 300, padding: '4px 0',
                  background: 'transparent', border: 'none', outline: 'none',
                }}
              />
            </div>

            {/* Deltagere chips */}
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

            {/* Teams meeting link input */}
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
            {/* Eyebrow */}
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)',
              letterSpacing: 0.4,
            }}>status</div>

            {/* Hviske status */}
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

            {/* Mic status */}
            <div style={{ marginTop: 18 }}>
              <div style={{
                fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted-2)',
                marginBottom: 8, letterSpacing: 0.4,
              }}>mikrofon</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.6 }}>
                der anmodes om adgang, når du starter en optagelse
              </div>
            </div>

            {/* Compliance */}
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
                slettes automatisk efter 14 dage<br />
                personoplysninger fjernes inden referat
              </div>
            </div>
          </div>
        </div>

        {/* Footer hint — right-aligned, archive link only */}
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
