'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { ErrorBanner } from '@/components/ui/error-banner';
import { diffLines, hasChanges } from '@/lib/skabeloner/diff';
import type { CentralTemplateVersion } from '@/lib/skabeloner/central-types';
import { apiRequest } from './api';
import {
  changeTypeLabels,
  changedContentFields,
  contentFieldLabels,
  diffTargets,
  formatTime,
} from './central-template-utils';

const LINE_STYLE = {
  insert: { background: 'color-mix(in oklch, var(--ok) 14%, var(--surface))', mark: '+', sr: 'Tilføjet: ' },
  delete: { background: 'var(--danger-wash)', mark: '−', sr: 'Fjernet: ' },
  equal: { background: 'transparent', mark: ' ', sr: '' },
} as const;

/** Unified line diff of two prompt texts. */
export function PromptDiff({
  before,
  after,
  label = 'Forskel i prompt',
}: {
  before: string;
  after: string;
  label?: string;
}) {
  const result = useMemo(() => diffLines(before, after), [before, after]);
  if (!hasChanges(result)) {
    return <p className="text-[13px] text-[var(--muted)]">Prompten er uændret.</p>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      {result.approximate && (
        <p role="status" className="text-[13px] text-[var(--muted)]">
          Prompten er for stor til en detaljeret sammenligning. Hele det ændrede afsnit vises som fjernet og tilføjet.
        </p>
      )}
      <div
        role="group"
        aria-label={label}
        className="max-h-72 overflow-auto rounded-[var(--radius)] border border-[var(--line)] font-mono text-[12px] leading-5"
      >
        {result.lines.map((line, i) => {
          const s = LINE_STYLE[line.type];
          return (
            <div
              key={i}
              data-diff={line.type}
              className="flex gap-2 whitespace-pre-wrap break-words px-2"
              style={{ background: s.background }}
            >
              <span aria-hidden className="select-none text-[var(--muted)]">
                {s.mark}
              </span>
              <span className="sr-only">{s.sr}</span>
              <span>{line.text === '' ? ' ' : line.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Compact list of what changed besides the prompt text. */
function OtherChanges({
  before,
  after,
  unitName,
}: {
  before: CentralTemplateVersion | null;
  after: CentralTemplateVersion;
  unitName: (uuid: string) => string;
}) {
  const fields = before ? changedContentFields(before.content, after.content).filter((f) => f !== 'prompt') : [];
  const targets = diffTargets(before?.targets ?? [], after.targets);
  const lines: string[] = [
    ...fields.map((f) => `${contentFieldLabels[f]} ændret`),
    ...targets.added.map(
      (t) => `Modtager tilføjet: ${unitName(t.orgUnitUuid)}${t.includeDescendants ? ' (inkl. underenheder)' : ''}`,
    ),
    ...targets.removed.map((t) => `Modtager fjernet: ${unitName(t.orgUnitUuid)}`),
    ...targets.changed.map(
      (t) => `Modtager ${unitName(t.orgUnitUuid)}: ${t.includeDescendants ? 'inkl. underenheder' : 'kun enheden selv'}`,
    ),
  ];
  if (lines.length === 0) return null;
  return (
    <ul aria-label="Øvrige ændringer" className="list-disc pl-5 text-[13px] text-[var(--ink-2)]">
      {lines.map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
  );
}

interface Props {
  templateId: string;
  unitName: (uuid: string) => string;
}

/** Changelog of one central template, newest first, with a diff against the previous version. */
export function TemplateVersionHistory({ templateId, unitName }: Props) {
  const [versions, setVersions] = useState<CentralTemplateVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await apiRequest<{ versions: CentralTemplateVersion[] }>(
      `/api/admin/central-templates/${templateId}/versions`,
    );
    if (res.ok) {
      setVersions(res.data.versions);
      setSelected((cur) => cur ?? res.data.versions[0]?.version ?? null);
    } else {
      setError(res.message);
    }
    setLoading(false);
  }, [templateId]);
  useEffect(() => {
    load();
  }, [load]);

  const index = versions.findIndex((v) => v.version === selected);
  const current = index >= 0 ? versions[index] : null;
  const previous = index >= 0 ? (versions[index + 1] ?? null) : null;

  if (loading && versions.length === 0) return <p className="text-sm text-[var(--muted)]">Indlæser historik …</p>;
  return (
    <div className="flex flex-col gap-4">
      <ErrorBanner message={error} onRetry={load} />
      {versions.length === 0 && !error && <p className="text-sm text-[var(--muted)]">Ingen versioner</p>}

      {versions.length > 0 && (
        <ol
          aria-label="Versioner"
          className="flex max-h-60 flex-col overflow-y-auto rounded-[var(--radius)] border border-[var(--line)]"
        >
          {versions.map((v) => {
            const active = v.version === selected;
            return (
              <li key={v.version} className="border-b border-[var(--line)] last:border-0">
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => setSelected(v.version)}
                  className="flex w-full flex-col gap-1 px-3 py-2 text-left hover:bg-[var(--surface-2)]"
                  style={{ background: active ? 'var(--accent-wash)' : undefined }}
                >
                  <span className="flex flex-wrap items-center gap-2 text-sm text-[var(--ink)]">
                    <span className="font-medium">Version {v.version}</span>
                    <Badge variant="outline">{changeTypeLabels[v.changeType]}</Badge>
                    <span className="text-[13px] text-[var(--muted)]">
                      {v.changedByName ?? 'Ukendt'} · {formatTime(v.changedAt)}
                    </span>
                  </span>
                  <span className="text-[13px] text-[var(--ink-2)]">{v.changeNote}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {current && (
        <section aria-label={`Version ${current.version}`} className="flex flex-col gap-3">
          <h3 className="text-sm font-medium text-[var(--ink)]">
            {previous
              ? `Version ${current.version} sammenlignet med version ${previous.version}`
              : `Version ${current.version} (første version)`}
          </h3>
          <PromptDiff before={previous?.content.prompt ?? ''} after={current.content.prompt} />
          <OtherChanges before={previous} after={current} unitName={unitName} />
        </section>
      )}
    </div>
  );
}
