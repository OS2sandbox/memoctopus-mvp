'use client';

import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { CENTRAL_LIMITS } from '@/lib/skabeloner/central-types';
import { noteLength } from './central-template-utils';

/** The mandatory changelog entry, shown on every save including archive and restore. */
export function ChangeNoteField({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const len = noteLength(value);
  const short = len < CENTRAL_LIMITS.changeNoteMin;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Ændringsbeskrivelse</Label>
      <Textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        required
        aria-required="true"
        aria-describedby={`${id}-help ${id}-count`}
        aria-invalid={len > 0 && short ? true : undefined}
        disabled={disabled}
        placeholder="Hvad er ændret, og hvorfor?"
      />
      <div className="flex items-start justify-between gap-3 text-[13px]">
        <p id={`${id}-help`} className="text-[var(--muted)]">
          Påkrævet. Gemmes i skabelonens ændringshistorik sammen med dit navn.
        </p>
        <p
          id={`${id}-count`}
          className="shrink-0"
          style={{ color: len > 0 && short ? 'var(--danger)' : 'var(--muted)' }}
        >
          {len} / {CENTRAL_LIMITS.changeNoteMin} tegn mindst
        </p>
      </div>
    </div>
  );
}
