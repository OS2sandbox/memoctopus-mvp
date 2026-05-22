'use client';

import React, { useState, useEffect, useRef, KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { HviskeChip } from '@/components/layout/HviskeChip';

export default function OptaqPage() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [participants, setParticipants] = useState('');
  const [loading, setLoading] = useState(false);
  const [meetingCount, setMeetingCount] = useState<number | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  // Fetch meeting count for footer link
  useEffect(() => {
    fetch('/api/meetings?count=1')
      .then((r) => r.json())
      .then((d) => setMeetingCount(d.count ?? null))
      .catch(() => {});
  }, []);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  async function startRecording() {
    if (loading) return;
    setLoading(true);
    try {
      const body: Record<string, unknown> = {
        title: title.trim() || `Møde · ${new Intl.DateTimeFormat('da', { day: 'numeric', month: 'long' }).format(new Date())}`,
      };
      if (participants.trim()) {
        body.participants = participants.split(',').map((p) => p.trim()).filter(Boolean);
      }
      const res = await fetch('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.id) {
        router.push(`/meeting/${data.id}?autostart=1`);
      }
    } catch {
      setLoading(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT') return;
    if (e.key === 'r' || e.key === 'R') startRecording();
    if (e.key === 'u' || e.key === 'U') document.getElementById('upload-input')?.click();
  }

  function handleTitleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') startRecording();
  }

  return (
    <div
      className="min-h-screen bg-[var(--bg)]"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
      style={{ outline: 'none' }}
    >
      <div className="mx-auto max-w-[1040px] px-6" style={{ paddingTop: 120 }}>
        {/* Greeting */}
        <div className="mb-12">
          <h1
            style={{
              fontSize: 'var(--t-display)',
              fontWeight: 300,
              lineHeight: 1.1,
              color: 'var(--ink)',
              margin: 0,
            }}
          >
            Klar til møde.
          </h1>
          <p className="mt-3 text-[var(--muted)]" style={{ fontSize: 'var(--t-body)' }}>
            Giv mødet en titel, eller optag med det samme.
          </p>
        </div>

        {/* Input area + record button */}
        <div className="flex items-start gap-12">
          {/* Inputs */}
          <div className="flex-1 max-w-[560px]">
            <input
              ref={titleRef}
              type="text"
              placeholder="Hvad handler mødet om?"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={handleTitleKeyDown}
              style={{
                width: '100%',
                fontSize: '26px',
                fontWeight: 300,
                border: 'none',
                background: 'transparent',
                outline: 'none',
                color: 'var(--ink)',
                padding: 0,
                caretColor: 'var(--accent)',
              }}
              className="placeholder:text-[var(--muted-2)]"
            />
            <div className="mt-4 border-t border-[var(--line)] pt-4">
              <input
                type="text"
                placeholder="Deltagere — valgfrit"
                value={participants}
                onChange={(e) => setParticipants(e.target.value)}
                style={{
                  width: '100%',
                  fontSize: 'var(--t-body)',
                  border: 'none',
                  background: 'transparent',
                  outline: 'none',
                  color: 'var(--ink)',
                  padding: 0,
                }}
                className="placeholder:text-[var(--muted-2)]"
              />
            </div>

            {/* Status row below inputs */}
            <div className="mt-5 flex items-center justify-between">
              <HviskeChip label="Hviske · klar" />
              <label
                htmlFor="upload-input"
                className="text-sm text-[var(--muted)] hover:text-[var(--ink)] cursor-pointer transition-colors"
              >
                Upload lydfil i stedet →
              </label>
              <input
                id="upload-input"
                type="file"
                accept="audio/*,video/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) router.push('/meeting/new?mode=upload');
                }}
              />
            </div>
          </div>

          {/* Record button */}
          <div className="flex flex-col items-center gap-3 shrink-0">
            <button
              onClick={startRecording}
              disabled={loading}
              aria-label="Start optagelse"
              style={{
                width: 120,
                height: 120,
                borderRadius: '50%',
                backgroundColor: loading ? 'var(--ink-2)' : 'var(--ink)',
                border: 'none',
                cursor: loading ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'background-color 0.15s',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              {/* White dot */}
              <span
                style={{
                  display: 'block',
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  backgroundColor: 'white',
                }}
              />
            </button>
            <span
              className="text-[var(--muted)]"
              style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--t-micro)', letterSpacing: '-0.02em' }}
            >
              optag
            </span>
          </div>
        </div>

        {/* Footer hint row */}
        <div
          className="mt-16 flex items-center justify-between"
          style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--t-micro)', color: 'var(--muted-2)' }}
        >
          <span>[R] start straks · [U] upload lydfil</span>
          {meetingCount === 0 || meetingCount === null ? (
            <span className="text-[var(--muted-2)]">Du har ikke optaget noget endnu.</span>
          ) : (
            <Link
              href="/arkiv"
              className="text-[var(--muted)] hover:text-[var(--ink)] transition-colors"
            >
              Se {meetingCount} tidligere møder i arkivet →
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
