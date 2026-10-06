import { roleDescriptions, roleLabels } from '@/lib/authz/labels.da';
import { ROLE_KEYS } from '@/lib/authz/types';

/**
 * Shown instead of the role controls while Rollekatalog owns the roles: says where roles are
 * assigned and what the four roles mean. The wording of the roles comes from labels.da, the
 * same source as the rest of the admin UI.
 */
export function RoleSourceCard({ itSystem }: { itSystem: string | null | undefined }) {
  return (
    <section
      aria-labelledby="role-source-heading"
      className="rounded-[var(--radius)] border border-[var(--line-strong)] bg-[var(--surface-2)] px-4 py-3.5"
    >
      <h2 id="role-source-heading" className="text-[var(--t-h2)] font-light text-[var(--ink)]">
        Roller tildeles i Rollekatalog
      </h2>
      <p className="mt-1 text-[13px] leading-snug text-[var(--ink-2)]">
        Roller kan ikke ændres her.{' '}
        {itSystem ? (
          <>
            Tildel dem i Rollekatalog under it-systemet <code className="font-mono text-[12px]">{itSystem}</code>.
          </>
        ) : (
          'Tildel dem i Rollekatalog under løsningens it-system.'
        )}{' '}
        Ændringer vises her efter næste synkronisering. Tidspunktet for den seneste ses nedenfor.
      </p>
      <ul aria-label="Roller" className="mt-3 flex flex-col gap-1.5 text-[13px]">
        {ROLE_KEYS.map((key) => (
          <li key={key} className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium text-[var(--ink)]">{roleLabels[key]}</span>
            <code className="font-mono text-[12px] text-[var(--muted)]">{key}</code>
            <span className="text-[var(--ink-2)]">– {roleDescriptions[key]}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
