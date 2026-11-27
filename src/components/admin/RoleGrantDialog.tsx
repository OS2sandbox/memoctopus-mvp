'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ErrorBanner } from '@/components/ui/error-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { roleDescriptions, roleLabels } from '@/lib/authz/labels.da';
import { ROLE_KEYS, type RoleKey } from '@/lib/authz/types';
import { apiRequest } from './api';

interface GrantTarget {
  id: string;
  name: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: GrantTarget | null;
  onGranted: () => void;
}

export function RoleGrantDialog({ open, onOpenChange, user, onGranted }: Props) {
  return (
    <Dialog open={open && user !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {user && (
          <GrantForm
            user={user}
            onClose={() => onOpenChange(false)}
            onGranted={onGranted}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

interface FieldErrors {
  role?: string;
  dates?: string;
}

function GrantForm({
  user,
  onClose,
  onGranted,
}: {
  user: GrantTarget;
  onClose: () => void;
  onGranted: () => void;
}) {
  const { toast } = useToast();
  const [roleKey, setRoleKey] = useState<RoleKey | ''>('');
  const [startDate, setStartDate] = useState('');
  const [stopDate, setStopDate] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function changeRole(next: string) {
    setRoleKey(next as RoleKey | '');
    setErrors({});
  }

  function validate(): FieldErrors {
    const e: FieldErrors = {};
    if (!roleKey) e.role = 'Vælg en rolle';
    if (startDate && stopDate && stopDate <= startDate) e.dates = 'Slutdato skal ligge efter startdato';
    return e;
  }

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setServerError(null);
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length > 0 || !roleKey) return;

    setSubmitting(true);
    const res = await apiRequest('/api/admin/access/assignments', {
      method: 'POST',
      json: {
        appUserId: user.id,
        roleKey,
        scopeOrgUnitUuid: null,
        startDate: startDate || null,
        stopDate: stopDate || null,
      },
    });
    setSubmitting(false);
    if (!res.ok) {
      setServerError(res.message);
      return;
    }
    toast({ message: `Rollen »${roleLabels[roleKey]}« er tildelt ${user.name}`, variant: 'success' });
    onGranted();
    onClose();
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Tildel rolle</DialogTitle>
        <DialogDescription>Tildel en rolle til {user.name}.</DialogDescription>
      </DialogHeader>

      <ErrorBanner message={serverError} />

      <Select
        label="Rolle"
        value={roleKey}
        onChange={(e) => changeRole(e.target.value)}
        error={errors.role}
        hint={roleKey ? roleDescriptions[roleKey] : undefined}
      >
        <option value="">Vælg rolle</option>
        {ROLE_KEYS.map((r) => (
          <option key={r} value={r}>
            {roleLabels[r]}
          </option>
        ))}
      </Select>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="grant-start">Startdato (valgfri)</Label>
          <Input id="grant-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="grant-stop">Gælder indtil (valgfri)</Label>
          <Input
            id="grant-stop"
            type="date"
            value={stopDate}
            onChange={(e) => setStopDate(e.target.value)}
            aria-invalid={errors.dates ? true : undefined}
            aria-describedby={errors.dates ? 'grant-dates-error grant-stop-hint' : 'grant-stop-hint'}
          />
          {/* The stop date is exclusive (the grant is over when that day begins), matching Rollekatalog. */}
          <p id="grant-stop-hint" className="text-[12px] text-[var(--muted)]">
            Rollen gælder ikke selve datoen.
          </p>
        </div>
      </div>
      {errors.dates && (
        <p id="grant-dates-error" className="-mt-2 text-[13px] text-[var(--danger)]">
          {errors.dates}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
          Annuller
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Tildeler …' : 'Tildel rolle'}
        </Button>
      </DialogFooter>
    </form>
  );
}
