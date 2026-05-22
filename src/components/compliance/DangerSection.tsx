import React from 'react';
import { Button } from '@/components/ui/button';

interface DangerSectionProps {
  title: string;
  description: string;
  retentionNote?: string;
  actionLabel: string;
  onAction: () => void;
  disabled?: boolean;
}

export function DangerSection({
  title,
  description,
  retentionNote,
  actionLabel,
  onAction,
  disabled,
}: DangerSectionProps) {
  return (
    <div
      className="rounded-[var(--radius)] border px-6 py-5"
      style={{
        borderColor: 'var(--danger)',
        backgroundColor: 'var(--danger-wash)',
      }}
    >
      <div className="flex items-start justify-between gap-6">
        <div>
          <h3 className="font-medium text-[var(--ink)]" style={{ fontSize: 'var(--t-body)' }}>
            {title}
          </h3>
          <p className="mt-1 text-[var(--ink-2)]" style={{ fontSize: 'var(--t-small)' }}>
            {description}
          </p>
          {retentionNote && (
            <p
              className="mt-2 text-[var(--muted)]"
              style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--t-micro)' }}
            >
              {retentionNote}
            </p>
          )}
        </div>
        <Button
          variant="danger-ghost"
          size="sm"
          onClick={onAction}
          disabled={disabled}
          className="shrink-0"
        >
          {actionLabel}
        </Button>
      </div>
    </div>
  );
}
