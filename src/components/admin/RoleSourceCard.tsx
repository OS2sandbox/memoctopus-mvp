import { roleDescriptions, roleLabels } from '@/lib/authz/labels.da';
import type { AccessSource } from '@/lib/authz/config';
import { ROLE_KEYS } from '@/lib/authz/types';

function Intro({ source, itSystem }: { source: AccessSource; itSystem: string | null | undefined }) {
  if (source === 'claims') {
    return (
      <>
        <h2 id="role-source-heading" className="text-[var(--t-h2)] font-light text-[var(--ink)]">
          Roller følger med fra login
        </h2>
        <p className="mt-1 text-[13px] leading-snug text-[var(--ink-2)]">
          Roller kan ikke ændres her. De tildeles hos identitetsudbyderen (eller i det system, der ligger bag den) og
          følger med, hver gang en person logger ind. En ændring får først virkning, næste gang personen logger ind, og
          en rolle, der ikke længere følger med, fjernes samtidig. Her ses de roller, personerne fik ved sidste login.
        </p>
      </>
    );
  }
  if (source === 'local') {
    return (
      <>
        <h2 id="role-source-heading" className="text-[var(--t-h2)] font-light text-[var(--ink)]">
          Rolleadministration er slået fra
        </h2>
        <p className="mt-1 text-[13px] leading-snug text-[var(--ink-2)]">
          Den lokale rolleadministration er slået fra på denne installation, så roller kan ikke ændres her. Kontakt den
          driftsansvarlige, hvis en rolle skal ændres.
        </p>
      </>
    );
  }
  return (
    <>
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
    </>
  );
}

/**
 * Shown instead of the role controls while the roles are owned elsewhere (Rollekatalog, the
 * IdP's claims, or locked by the operator): says where roles are assigned and what the four roles
 * mean. The wording of the roles comes from labels.da, the same source as the rest of the admin UI.
 */
export function RoleSourceCard({
  itSystem,
  source = 'rollekatalog',
}: {
  itSystem?: string | null | undefined;
  source?: AccessSource;
}) {
  return (
    <section
      aria-labelledby="role-source-heading"
      className="rounded-[var(--radius)] border border-[var(--line-strong)] bg-[var(--surface-2)] px-4 py-3.5"
    >
      <Intro source={source} itSystem={itSystem} />
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
