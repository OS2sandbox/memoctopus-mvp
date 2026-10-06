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

const USER_PAGE = 500;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unit: { uuid: string; name: string } | null;
  onSaved: () => void;
}

/** Edits who belongs to a LOCAL unit. Viewing members is OrgUnitMembersList (read-only, any unit). */
export function OrgUnitMembersDialog({ open, onOpenChange, unit, onSaved }: Props) {
  return (
    <Dialog open={open && unit !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        {unit && <Body unit={unit} onClose={() => onOpenChange(false)} onSaved={onSaved} />}
      </DialogContent>
    </Dialog>
  );
}

function Body({
  unit,
  onClose,
  onSaved,
}: {
  unit: { uuid: string; name: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [users, setUsers] = useState<AppUserOption[]>([]);
  const [usersTruncated, setUsersTruncated] = useState(false);
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
    if (!membersLoaded) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const qs = query ? `&q=${encodeURIComponent(query)}` : '';
      const u = await apiRequest<{ users: AppUserOption[]; truncated?: boolean }>(`/api/admin/access/users?limit=${USER_PAGE}${qs}`);
      if (cancelled) return;
      if (!u.ok) return setLoadError(u.message);
      setLoadError(null);
      setUsers(u.data.users);
      setUsersTruncated(u.data.truncated === true);
    }, query ? 250 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [membersLoaded, query]);

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
        <DialogDescription>Vælg hvem der er medlem af {unit.name}.</DialogDescription>
      </DialogHeader>

      <ErrorBanner message={loadError} />
      <ErrorBanner message={saveError} />

      {members === null && !loadError && <p role="status" className="text-sm text-[var(--muted)]">Indlæser …</p>}

      {members !== null && (
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
          {usersTruncated && (
            <p role="note" className="text-[13px] text-[var(--muted)]">
              Viser de første {users.length}. Brug søgefeltet for at finde flere.
            </p>
          )}
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
          Annuller
        </Button>
        <Button type="button" onClick={save} disabled={saving || members === null}>
          {saving ? 'Gemmer …' : 'Gem medlemmer'}
        </Button>
      </DialogFooter>
    </div>
  );
}
