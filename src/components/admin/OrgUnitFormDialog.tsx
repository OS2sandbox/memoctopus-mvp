'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ErrorBanner } from '@/components/ui/error-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from './api';
import { flattenOrgTree, indentedLabel, selfAndDescendants, type TreeUnit } from './org-tree';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = create a new unit; otherwise rename and/or move this one. */
  unit: TreeUnit | null;
  orgUnits: TreeUnit[];
  onSaved: () => void;
}

export function OrgUnitFormDialog({ open, onOpenChange, unit, orgUnits, onSaved }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <Form unit={unit} orgUnits={orgUnits} onClose={() => onOpenChange(false)} onSaved={onSaved} />
      </DialogContent>
    </Dialog>
  );
}

const MAX_NAME = 200;

function Form({
  unit,
  orgUnits,
  onClose,
  onSaved,
}: {
  unit: TreeUnit | null;
  orgUnits: TreeUnit[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState(unit?.name ?? '');
  const [parent, setParent] = useState(unit?.parentUuid ?? '');
  const [nameError, setNameError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Offering the unit itself or a descendant as parent would only produce a
  // cycle; the server refuses it too, this just keeps the choice honest.
  const parentOptions = useMemo(() => {
    const blocked = unit ? selfAndDescendants(orgUnits, unit.uuid) : new Set<string>();
    return flattenOrgTree(orgUnits).filter((r) => !blocked.has(r.unit.uuid));
  }, [orgUnits, unit]);

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setServerError(null);
    const trimmed = name.trim();
    if (trimmed.length === 0) return setNameError('Angiv et navn');
    if (trimmed.length > MAX_NAME) return setNameError(`Navnet må højst være ${MAX_NAME} tegn`);
    setNameError(null);

    const nextParent = parent === '' ? null : parent;
    let res;
    setSaving(true);
    if (unit === null) {
      res = await apiRequest('/api/admin/access/org-units', { method: 'POST', json: { name: trimmed, parentUuid: nextParent } });
    } else {
      const patch: { name?: string; parentUuid?: string | null } = {};
      if (trimmed !== unit.name) patch.name = trimmed;
      if (nextParent !== unit.parentUuid) patch.parentUuid = nextParent;
      if (Object.keys(patch).length === 0) {
        setSaving(false);
        onClose();
        return;
      }
      res = await apiRequest(`/api/admin/access/org-units/${unit.uuid}`, { method: 'PATCH', json: patch });
    }
    setSaving(false);
    if (!res.ok) {
      setServerError(res.message);
      return;
    }
    toast({ message: unit ? 'Enheden er opdateret' : 'Enheden er oprettet', variant: 'success' });
    onSaved();
    onClose();
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{unit ? 'Rediger enhed' : 'Opret enhed'}</DialogTitle>
        <DialogDescription>
          {unit ? 'Omdøb enheden eller flyt den under en anden enhed.' : 'Opret en ny organisationsenhed.'}
        </DialogDescription>
      </DialogHeader>

      <ErrorBanner message={serverError} />

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="org-name">Navn</Label>
        <Input
          id="org-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? 'org-name-error' : undefined}
        />
        {nameError && (
          <p id="org-name-error" className="text-[13px] text-[var(--danger)]">
            {nameError}
          </p>
        )}
      </div>

      <Select label="Overordnet enhed" value={parent} onChange={(e) => setParent(e.target.value)}>
        <option value="">Øverste niveau (ingen overordnet enhed)</option>
        {parentOptions.map(({ unit: u, depth }) => (
          <option key={u.uuid} value={u.uuid}>
            {indentedLabel(u.name, depth)}
          </option>
        ))}
      </Select>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
          Annuller
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? 'Gemmer …' : unit ? 'Gem' : 'Opret'}
        </Button>
      </DialogFooter>
    </form>
  );
}
