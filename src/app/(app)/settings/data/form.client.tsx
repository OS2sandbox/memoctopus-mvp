'use client';

import React, { useEffect, useState } from 'react';
import { DangerSection } from '@/components/compliance/DangerSection';
import { getAllMeetings, deleteAudio, updateMeeting, getTranscript, saveTranscript } from '@/lib/storage';

interface UsageData {
  meetingCount: number;
  audioBytes: number;
  oldestMeeting: string | null;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export default function SettingsDataPage() {
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getAllMeetings()
      .then((meetings) => {
        const audioBytes = meetings.reduce((sum, m) => sum + (m.audioDeleted ? 0 : (m.audioSizeBytes ?? 0)), 0);
        const oldest = meetings.length > 0 ? meetings[meetings.length - 1].createdAt : null;
        setUsage({ meetingCount: meetings.length, audioBytes, oldestMeeting: oldest });
      })
      .catch(() => setUsage(null))
      .finally(() => setLoading(false));
  }, []);

  async function deleteAllAudio() {
    const meetings = await getAllMeetings();
    await Promise.all(
      meetings
        .filter((m) => !m.audioDeleted)
        .map(async (m) => {
          await deleteAudio(m.id);
          await updateMeeting(m.id, { audioDeleted: true });
        }),
    );
    setUsage((u) => u ? { ...u, audioBytes: 0 } : u);
  }

  async function deleteAllSensitive() {
    const meetings = await getAllMeetings();
    await Promise.all(
      meetings
        .filter((m) => m.status !== 'redacted')
        .map(async (m) => {
          const transcript = await getTranscript(m.id);
          if (transcript) {
            await saveTranscript(m.id, {
              rawText: '',
              segments: [],
              chapters: transcript.chapters,
              piiReplacements: [],
              piiRemovedAt: new Date().toISOString(),
            });
          }
          await deleteAudio(m.id);
          await updateMeeting(m.id, { status: 'redacted', audioDeleted: true });
        }),
    );
    setUsage((u) => u ? { ...u, audioBytes: 0 } : u);
  }

  return (
    <div className="mx-auto max-w-[720px] px-6 py-12">
      <h1
        style={{ fontSize: 'var(--t-h1)', fontWeight: 300, color: 'var(--ink)', margin: '0 0 8px' }}
      >
        Data & privatliv
      </h1>
      <p className="text-[var(--muted)] mb-16" style={{ fontSize: 'var(--t-body)' }}>
        Administrér dine data og slet indhold.
      </p>

      {/* Section 1 — Usage */}
      <section className="mb-16">
        <h2
          className="font-medium text-[var(--ink)] mb-4"
          style={{ fontSize: 'var(--t-h2)' }}
        >
          Mødedata
        </h2>
        {loading ? (
          <p className="text-[var(--muted)]" style={{ fontSize: 'var(--t-small)' }}>Indlæser…</p>
        ) : usage ? (
          <div className="flex flex-wrap gap-x-12 gap-y-6">
            <Stat label="Møder i alt" value={usage.meetingCount.toString()} />
            <Stat label="Lyd i alt" value={formatBytes(usage.audioBytes)} />
            {usage.oldestMeeting && (
              <Stat
                label="Ældste møde"
                value={new Intl.DateTimeFormat('da', { dateStyle: 'medium' }).format(
                  new Date(usage.oldestMeeting),
                )}
              />
            )}
          </div>
        ) : (
          <p className="text-[var(--muted)]" style={{ fontSize: 'var(--t-small)' }}>
            Kunne ikke hente data.
          </p>
        )}
      </section>

      <div className="border-t border-[var(--line)] mb-16" />

      {/* Section 2 — Delete audio */}
      <section className="mb-16">
        <h2
          className="font-medium text-[var(--ink)] mb-1"
          style={{ fontSize: 'var(--t-h2)' }}
        >
          Slet alle lydfiler
        </h2>
        <p className="text-[var(--muted)] mb-6" style={{ fontSize: 'var(--t-small)' }}>
          Beholder transskriptioner og referater. Lydfiler slettes automatisk, når referatet er genereret.
        </p>
        <DangerSection
          title="Slet alle lydfiler nu"
          description="Sletter alle lydfiler på tværs af alle møder. Transskriptioner og referater bevares."
          retentionNote="Automatisk sletning: når referatet genereres"
          actionLabel="Slet alle lydfiler"
          onAction={deleteAllAudio}
        />
      </section>

      <div className="border-t border-[var(--line)] mb-16" />

      {/* Section 3 — Delete all sensitive */}
      <section className="mb-16">
        <h2
          className="font-medium text-[var(--ink)] mb-1"
          style={{ fontSize: 'var(--t-h2)' }}
        >
          Slet alt følsomt indhold
        </h2>
        <p className="text-[var(--muted)] mb-6" style={{ fontSize: 'var(--t-small)' }}>
          Kører "Slet følsomt indhold" på alle møder. Referaterne bevares. Rå transskriptioner slettes automatisk 90 dage efter referatgodkendelse.
        </p>
        <DangerSection
          title="Slet alt følsomt indhold for alle møder"
          description="Vi sletter lydfilen, den rå transskription og PII-mappen for hvert møde. Det færdige, anonymiserede referat beholdes."
          retentionNote="Automatisk sletning: 90 dage efter referatgodkendelse"
          actionLabel="Slet alt følsomt indhold"
          onAction={deleteAllSensitive}
        />
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[var(--muted)]" style={{ fontSize: 'var(--t-small)' }}>
        {label}
      </p>
      <p
        className="mt-0.5 font-medium text-[var(--ink)]"
        style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--t-h2)' }}
      >
        {value}
      </p>
    </div>
  );
}
