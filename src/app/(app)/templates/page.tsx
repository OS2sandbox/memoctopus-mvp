import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { queryUserSchema } from '@/lib/db/user-schema';
import { Badge } from '@/components/ui/badge';
import { Template, TemplateStructure } from '@/types';

export const dynamic = 'force-dynamic';

export default async function TemplatesPage() {
  const session = await auth.api.getSession({ headers: await headers() });

  const rows = await queryUserSchema<{
    id: string;
    name: string;
    description: string;
    structure: unknown;
    is_default: boolean;
  }>(
    session.user.id,
    'SELECT id, name, description, structure, is_default FROM templates ORDER BY is_default DESC, name ASC',
  );

  const templates: Template[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    structure: r.structure as TemplateStructure,
    isDefault: r.is_default,
  }));

  return (
    <div className="mx-auto max-w-[960px] px-4 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-[var(--ink)]">Skabeloner</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Skabeloner bruges til at strukturere referater. Claude foreslår automatisk den bedst
          egnede skabelon ud fra transskriptionen.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {templates.map((t) => (
          <div
            key={t.id}
            className="rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--surface)] p-5"
          >
            <div className="flex items-start justify-between gap-2 mb-2">
              <h2 className="font-semibold text-[var(--ink)]">{t.name}</h2>
              {t.isDefault && <Badge variant="default">Standard</Badge>}
            </div>
            <p className="text-sm text-[var(--muted)] mb-4">{t.description}</p>
            <div>
              <p className="text-xs font-medium text-[var(--ink-2)] mb-2">Sektioner:</p>
              <ul className="space-y-1">
                {t.structure.sections.map((s) => (
                  <li key={s.key} className="flex items-center gap-2 text-xs text-[var(--muted)]">
                    <span
                      className={`inline-block h-1.5 w-1.5 rounded-full ${
                        s.required ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
                      }`}
                    />
                    {s.label}
                    {!s.required && (
                      <span className="text-[var(--line-strong)]">(valgfri)</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ))}
      </div>

      {templates.length === 0 && (
        <div className="rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--surface)] px-8 py-12 text-center">
          <p className="text-sm text-[var(--muted)]">Ingen skabeloner fundet.</p>
        </div>
      )}
    </div>
  );
}
