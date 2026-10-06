'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ErrorBanner } from '@/components/ui/error-banner';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from './api';

interface Member {
  directoryUserUuid: string;
  appUserId: string | null;
  name: string;
}

interface AppUserOption {
  id: string;
  name: string;
  email: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unit: { uuid: string; name: string } | null;
  /** Advisory: false shows the members without any way to change them. */
  editable: boolean;
  onSaved: () => void;
}

export function OrgUnitMembersDialog({ open, onOpenChange, unit, editable, onSaved }: Props) {
  return (
    <Dialog open={open && unit !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        {unit && <Body unit={unit} editable={editable} onClose={() => onOpenChange(false)} onSaved={onSaved} />}
      </DialogContent>
    </Dialog>
  );
}

function Body({
  unit,
  editable,
  onClose,
  onSaved,
}: {
  unit: { uuid: string; name: string };
  editable: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [users, setUsers] = useState<AppUserOption[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const m = await apiRequest<{ members: Member[] }>(`/api/admin/access/org-units/${unit.uuid}/members`);
      if (cancelled) return;
      if (!m.ok) return setLoadError(m.message);
      setMembers(m.data.members);
      setSelected(new Set(m.data.members.flatMap((x) => (x.appUserId ? [x.appUserId] : []))));
    })();
    return () => {
      cancelled = true;
    };
  }, [unit.uuid]);

  // The filter is applied by the server (`q`): the endpoint caps a page at 500
  // users, so filtering that page in the browser could never find user 501+.
  const query = filter.trim();
  const membersLoaded = members !== null;
  useEffect(() => {
    if (!editable || !membersLoaded) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const qs = query ? `&q=${encodeURIComponent(query)}` : '';
      const u = await apiRequest<{ users: AppUserOption[] }>(`/api/admin/access/users?limit=500${qs}`);
      if (cancelled) return;
      if (!u.ok) return setLoadError(u.message);
      setLoadError(null);
      setUsers(u.data.users);
    }, query ? 250 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [editable, membersLoaded, query]);

  const unlinked = members?.filter((m) => m.appUserId === null) ?? [];

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setSaveError(null);
    // PUT replaces the whole membership; ids not in the loaded user page are kept because they stay in `selected`.
    const res = await apiRequest(`/api/admin/access/org-units/${unit.uuid}/members`, {
      method: 'PUT',
      json: { appUserIds: [...selected] },
    });
    setSaving(false);
    if (!res.ok) return setSaveError(res.message);
    toast({ message: 'Medlemmerne er gemt', variant: 'success' });
    onSaved();
    onClose();
  }

  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Medlemmer</DialogTitle>
        <DialogDescription>
          {editable ? `Vælg hvem der er medlem af ${unit.name}.` : `Medlemmer af ${unit.name}.`}
        </DialogDescription>
      </DialogHeader>

      <ErrorBanner message={loadError} />
      <ErrorBanner message={saveError} />

      {members === null && !loadError && <p className="text-sm text-[var(--muted)]">Indlæser …</p>}

      {members !== null && !editable && (
        members.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">Ingen medlemmer</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {members.map((m) => (
              <li key={m.directoryUserUuid}>{m.name}</li>
            ))}
          </ul>
        )
      )}

      {members !== null && editable && (
        <>
          <Input aria-label="Filtrer brugere" placeholder="Filtrer på navn eller e-mail" maxLength={100} value={filter} onChange={(e) => setFilter(e.target.value)} />
          <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto" aria-label="Brugere">
            {users.length === 0 ? (
              <li className="text-sm text-[var(--muted)]">Ingen brugere fundet</li>
            ) : (
              users.map((u) => (
                <li key={u.id}>
                  <label className="flex items-center gap-2 text-sm text-[var(--ink)]">
                    <input
                      type="checkbox"
                      checked={selected.has(u.id)}
                      onChange={() => toggle(u.id)}
                      className="h-4 w-4 accent-[var(--accent)]"
                    />
                    <span>{u.name}</span>
                    <span className="font-mono text-[12px] text-[var(--muted)]">{u.email}</span>
                  </label>
                </li>
              ))
            )}
          </ul>
          {unlinked.length > 0 && (
            <p role="note" className="text-[13px] text-[var(--warn)]">
              {unlinked.length === 1 ? '1 medlem er' : `${unlinked.length} medlemmer er`} ikke knyttet til en bruger og
              fjernes, når du gemmer.
            </p>
          )}
        </>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
          {editable ? 'Annuller' : 'Luk'}
        </Button>
        {editable && (
          <Button type="button" onClick={save} disabled={saving || members === null}>
            {saving ? 'Gemmer …' : 'Gem medlemmer'}
          </Button>
        )}
      </DialogFooter>
    </div>
  );
}
