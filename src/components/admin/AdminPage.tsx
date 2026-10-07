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

const READ_ONLY_TEXT = {
  rollekatalog: 'Roller og organisation styres af Rollekatalog og kan ikke ændres her.',
  claims: 'Roller følger med fra identitetsudbyderen ved login og kan ikke ændres her.',
  local: 'Den lokale rolle- og organisationsadministration er slået fra.',
} as const;

/** Shown instead of write controls when roles and organisation are owned outside the app. */
export function ReadOnlyBanner({ source = 'rollekatalog' }: { source?: keyof typeof READ_ONLY_TEXT }) {
  return (
    <div
      role="status"
      className="rounded-[var(--radius)] border border-[var(--line-strong)] bg-[var(--surface-2)] px-3 py-2.5 text-[13px] leading-snug text-[var(--ink-2)]"
    >
      <strong className="font-medium">Skrivebeskyttet.</strong> {READ_ONLY_TEXT[source]}
    </div>
  );
}
