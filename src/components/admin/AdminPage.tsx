import type { ReactNode } from 'react';

export function AdminPage({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-[1040px] px-6 py-8">
      <h1 style={{ fontSize: 'var(--t-h1)', fontWeight: 300, color: 'var(--ink)', margin: 0, lineHeight: 1.2 }}>{title}</h1>
      {description && (
        <p className="mt-1 text-[var(--muted)]" style={{ fontSize: 'var(--t-small)' }}>
          {description}
        </p>
      )}
      <div className="mt-6 flex flex-col gap-6">{children}</div>
    </div>
  );
}
