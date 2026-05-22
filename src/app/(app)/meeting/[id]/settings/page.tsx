'use client';

import React from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ProcessStrip } from '@/components/layout/ProcessStrip';

export default function MeetingSettingsPage() {
  const params = useParams();
  const id = params.id as string;

  return (
    <div>
      <ProcessStrip meetingId={id} activePhase="export" />
      <div className="mx-auto max-w-[720px] px-6 py-12">
        <h1
          style={{ fontSize: 'var(--t-h1)', fontWeight: 300, color: 'var(--ink)', margin: '0 0 32px' }}
        >
          Mødeindstillinger
        </h1>

        <div className="divide-y divide-[var(--line)]">
          {/* Rename */}
          <SettingRow
            title="Omdøb møde"
            description="Skift titlen på dette møde."
          >
            <Button variant="outline" size="sm" asChild>
              <Link href="#rename">Omdøb</Link>
            </Button>
          </SettingRow>

          {/* Export raw data */}
          <SettingRow
            title="Eksportér rå data"
            description="Download en zip med lyd og transskriptionsfil."
          >
            <Button variant="outline" size="sm" asChild>
              <a href={`/api/meetings/${id}/export-raw`}>Download zip</a>
            </Button>
          </SettingRow>

          {/* Redact sensitive content */}
          <SettingRow
            title="Slet følsomt indhold"
            description="Slet lyd, rå transskription og PII permanent. Referatet beholdes."
          >
            <Button variant="danger-ghost" size="sm" asChild>
              <Link href={`/meeting/${id}/settings#redact`}>Slet følsomt indhold</Link>
            </Button>
          </SettingRow>

          {/* Delete entire meeting */}
          <SettingRow
            title="Slet hele mødet"
            description="Slet mødet og alt tilhørende indhold permanent."
          >
            <Button variant="danger-ghost" size="sm" asChild>
              <Link href={`/meeting/${id}/settings#delete`}>Slet mødet</Link>
            </Button>
          </SettingRow>
        </div>
      </div>
    </div>
  );
}

function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between py-5">
      <div>
        <p className="font-medium text-[var(--ink)]" style={{ fontSize: 'var(--t-body)' }}>
          {title}
        </p>
        <p className="mt-0.5 text-[var(--muted)]" style={{ fontSize: 'var(--t-small)' }}>
          {description}
        </p>
      </div>
      <div className="shrink-0 ml-6">{children}</div>
    </div>
  );
}
