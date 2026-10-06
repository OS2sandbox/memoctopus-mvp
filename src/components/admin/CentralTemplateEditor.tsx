'use client';

import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ErrorBanner } from '@/components/ui/error-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { CENTRAL_LIMITS } from '@/lib/skabeloner/central-types';
import type {
  CentralScopeOrgUnit,
  CentralTarget,
  CentralTemplateAdmin,
  CentralTemplateContent,
} from '@/lib/skabeloner/central-types';
import { apiRequest } from './api';
import { ChangeNoteField } from './CentralTemplatesChangeNote';
import {
  changedContentFields,
  conflictMessage,
  contentFieldLabels,
  diffTargets,
  formatTime,
  noteProblem,
  targetsEqual,
  targetsWithinOwner,
  unitNameLookup,
} from './central-template-utils';
import { flattenOrgTree, indentedLabel } from './org-tree';
import { OrgUnitTargetPicker } from './OrgUnitTargetPicker';
import { PromptDiff } from './TemplateVersionHistory';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = create a new central template. */
  template: CentralTemplateAdmin | null;
  /** Units inside the caller's template.manage scope (owner and recipient pickers). */
  units: CentralScopeOrgUnit[];
  onSaved: () => void;
}

export function CentralTemplateEditor({ open, onOpenChange, template, units, onSaved }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <EditorForm template={template} units={units} onClose={() => onOpenChange(false)} onSaved={onSaved} />
      </DialogContent>
    </Dialog>
  );
}

const CATEGORIES = [
  ['includeDeltagere', 'Deltagere'],
  ['includeBeslutningspunkter', 'Beslutningspunkter'],
  ['includeDagsorden', 'Dagsorden'],
  ['includeDato', 'Dato'],
] as const;

const EMPTY: CentralTemplateContent = {
  name: '',
  description: '',
  prompt: '',
  includeDeltagere: false,
  includeBeslutningspunkter: false,
  includeDagsorden: false,
  includeDato: false,
  allowUserInstruction: false,
  allowToggleOverrides: false,
};

function contentOf(t: CentralTemplateAdmin | null): CentralTemplateContent {
  if (!t) return EMPTY;
  return {
    name: t.name,
    description: t.description,
    prompt: t.prompt,
    includeDeltagere: t.includeDeltagere,
    includeBeslutningspunkter: t.includeBeslutningspunkter,
    includeDagsorden: t.includeDagsorden,
    includeDato: t.includeDato,
    allowUserInstruction: t.allowUserInstruction,
    allowToggleOverrides: t.allowToggleOverrides,
  };
}

function EditorForm({
  template,
  units,
  onClose,
  onSaved,
}: {
  template: CentralTemplateAdmin | null;
  units: CentralScopeOrgUnit[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  // What the edit is based on. Replaced only by an explicit reload after a conflict.
  const [base, setBase] = useState<CentralTemplateAdmin | null>(template);
  const [content, setContent] = useState<CentralTemplateContent>(() => contentOf(template));
  const [owner, setOwner] = useState(template?.ownerOrgUnitUuid ?? '');
  const [targets, setTargets] = useState<CentralTarget[]>(() => template?.targets ?? []);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  // Set by a 409: the saved version moved on; saving stays blocked until the user has reloaded.
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<CentralTemplateAdmin | null>(null);
  const [reloading, setReloading] = useState(false);

  const editing = template !== null;
  const unitName = useMemo(() => unitNameLookup(units), [units]);
  const ownerOptions = useMemo(() => flattenOrgTree(units), [units]);

  const set = <K extends keyof CentralTemplateContent>(key: K, value: CentralTemplateContent[K]) =>
    setContent((c) => ({ ...c, [key]: value }));

  function changeOwner(next: string) {
    setOwner(next);
    // Targets must stay inside the owner's subtree.
    setTargets((t) => targetsWithinOwner(units, next, t));
  }

  const changedFields = base ? changedContentFields(contentOf(base), content) : [];
  const targetsChanged = base ? !targetsEqual(base.targets, targets) : false;
  const archivedNow = latest?.status === 'archived';

  // First blocking reason, shown next to the disabled save button.
  const reason = ((): string | null => {
    if (!editing && !owner) return 'Vælg en ejerenhed';
    if (content.name.trim() === '') return 'Angiv et navn';
    if (content.prompt.trim() === '') return 'Angiv en prompt';
    if (editing && changedFields.length === 0 && !targetsChanged) return 'Ingen ændringer at gemme';
    if (conflict && !latest) return 'Genindlæs den gemte version, før du gemmer';
    if (archivedNow) return 'Skabelonen er arkiveret. Gendan den, før du ændrer den';
    return noteProblem(note);
  })();

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    if (reason !== null || saving) return;
    setServerError(null);
    setSaving(true);
    const res = editing
      ? await apiRequest<{ template: CentralTemplateAdmin }>(`/api/admin/central-templates/${base!.id}`, {
          method: 'PUT',
          json: {
            baseVersion: base!.currentVersion,
            changeNote: note.trim(),
            ...Object.fromEntries(changedFields.map((f) => [f, content[f]])),
            ...(targetsChanged ? { targets } : {}),
          },
        })
      : await apiRequest<{ template: CentralTemplateAdmin }>('/api/admin/central-templates', {
          method: 'POST',
          json: { ownerOrgUnitUuid: owner, ...content, targets, changeNote: note.trim() },
        });
    setSaving(false);
    if (!res.ok) {
      if (res.status === 409 && res.code === 'version_conflict') {
        setConflict(true);
        setLatest(null);
        setServerError(res.currentVersion !== undefined ? conflictMessage(res.currentVersion) : res.message);
      } else {
        setServerError(res.message);
      }
      return;
    }
    toast({ message: editing ? 'Skabelonen er gemt' : 'Skabelonen er oprettet', variant: 'success' });
    onSaved();
    onClose();
  }

  // Loads the saved version next to the user's text; the form itself is left alone.
  async function reload() {
    if (!base) return;
    setReloading(true);
    const res = await apiRequest<{ template: CentralTemplateAdmin }>(`/api/admin/central-templates/${base.id}`);
    setReloading(false);
    if (!res.ok) return setServerError(res.message);
    setLatest(res.data.template);
    setBase(res.data.template);
    setServerError(null);
  }

  function discardMine() {
    if (!latest) return;
    setContent(contentOf(latest));
    setTargets(latest.targets);
    setNote('');
    setConflict(false);
    setLatest(null);
  }

  const latestFields = latest ? changedContentFields(contentOf(latest), content) : [];
  const latestTargets = latest ? diffTargets(latest.targets, targets) : null;

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{editing ? 'Rediger central skabelon' : 'Ny central skabelon'}</DialogTitle>
        <DialogDescription>
          Brugerne kan ikke ændre en central skabelon. Kun du og andre skabelonansvarlige kan redigere den.
        </DialogDescription>
      </DialogHeader>

      {editing && base && (
        <p className="text-[13px] text-[var(--muted)]">
          <Badge variant="outline">Version {base.currentVersion}</Badge> Senest ændret af{' '}
          {base.lastEditedByName ?? 'ukendt'}, {formatTime(base.lastEditedAt)}
        </p>
      )}

      <ErrorBanner message={serverError} onRetry={conflict && !reloading ? reload : undefined} retryLabel="Genindlæs" />

      {latest && conflict && (
        <section
          aria-label="Seneste gemte version"
          className="flex flex-col gap-3 rounded-[var(--radius)] border border-[var(--line-strong)] bg-[var(--surface-2)] p-3"
        >
          <p className="text-[13px] text-[var(--ink-2)]">
            Seneste gemte version er version {latest.currentVersion}. Dine ændringer er ikke tabt. Hvis du gemmer nu,
            erstatter det, du ser i formularen, den gemte version. Tjek forskellene nedenfor først, eller kassér dine
            ændringer.
          </p>
          <p className="text-[13px] font-medium text-[var(--ink)]">Prompt: gemt version mod din tekst</p>
          <PromptDiff before={latest.prompt} after={content.prompt} label="Forskel mellem gemt version og din prompt" />
          {(latestFields.filter((f) => f !== 'prompt').length > 0 ||
            (latestTargets &&
              (latestTargets.added.length || latestTargets.removed.length || latestTargets.changed.length) > 0)) && (
            <ul aria-label="Øvrige forskelle" className="list-disc pl-5 text-[13px] text-[var(--ink-2)]">
              {latestFields
                .filter((f) => f !== 'prompt')
                .map((f) => (
                  <li key={f}>{contentFieldLabels[f]} er forskellig fra den gemte version</li>
                ))}
              {latestTargets && !targetsEqual(latest.targets, targets) && (
                <li>Modtagerne er forskellige fra den gemte version</li>
              )}
            </ul>
          )}
          <div>
            <Button type="button" size="sm" variant="outline" onClick={discardMine}>
              Kassér mine ændringer og brug den gemte version
            </Button>
          </div>
        </section>
      )}

      {editing ? (
        <p className="text-sm text-[var(--ink)]">
          <span className="font-medium">Ejerenhed:</span> {unitName(base!.ownerOrgUnitUuid)}
        </p>
      ) : (
        <Select
          label="Ejerenhed"
          value={owner}
          onChange={(e) => changeOwner(e.target.value)}
          hint="Skabelonen kan administreres af alle, der er skabelonansvarlige for denne enhed. Modtagerne skal ligge under den."
        >
          <option value="">Vælg enhed …</option>
          {ownerOptions.map(({ unit, depth }) => (
            <option key={unit.uuid} value={unit.uuid}>
              {indentedLabel(unit.name, depth)}
            </option>
          ))}
        </Select>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ct-name">Navn</Label>
        <Input
          id="ct-name"
          value={content.name}
          maxLength={CENTRAL_LIMITS.name}
          onChange={(e) => set('name', e.target.value)}
          required
          aria-required="true"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ct-desc">Beskrivelse</Label>
        <Input
          id="ct-desc"
          value={content.description}
          maxLength={CENTRAL_LIMITS.description}
          onChange={(e) => set('description', e.target.value)}
          placeholder="Kort beskrivelse, som modtagerne ser"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ct-prompt">Prompt</Label>
        <Textarea
          id="ct-prompt"
          value={content.prompt}
          maxLength={CENTRAL_LIMITS.prompt}
          onChange={(e) => set('prompt', e.target.value)}
          rows={8}
          required
          aria-required="true"
          aria-describedby="ct-prompt-help"
        />
        <p id="ct-prompt-help" className="text-[13px] text-[var(--muted)]">
          Modtagerne kan bruge skabelonen, men de kan ikke se eller ændre prompten.
        </p>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-[var(--ink)]">Kategorier</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {CATEGORIES.map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 text-sm text-[var(--ink)]">
              <input type="checkbox" checked={content[key]} onChange={(e) => set(key, e.target.checked)} />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium text-[var(--ink)]">Hvad må brugeren selv ændre?</legend>
        <div className="flex flex-col gap-1">
          <label className="flex items-center gap-2 text-sm text-[var(--ink)]">
            <input
              type="checkbox"
              role="switch"
              checked={content.allowUserInstruction}
              onChange={(e) => set('allowUserInstruction', e.target.checked)}
              aria-describedby="ct-allow-instr-help"
            />
            Tillad bruger at tilføje en egen instruktion
          </label>
          <p id="ct-allow-instr-help" className="pl-6 text-[13px] text-[var(--muted)]">
            Slået fra: prompten bruges uændret. Slået til: brugeren kan skrive en ekstra instruktion, som lægges efter
            din prompt.
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <label className="flex items-center gap-2 text-sm text-[var(--ink)]">
            <input
              type="checkbox"
              role="switch"
              checked={content.allowToggleOverrides}
              onChange={(e) => set('allowToggleOverrides', e.target.checked)}
              aria-describedby="ct-allow-toggle-help"
            />
            Tillad bruger at slå kategorier til og fra
          </label>
          <p id="ct-allow-toggle-help" className="pl-6 text-[13px] text-[var(--muted)]">
            Slået fra: kategorierne ovenfor er faste. Slået til: brugeren kan vælge andre kategorier ved generering.
          </p>
        </div>
      </fieldset>

      <OrgUnitTargetPicker units={units} ownerUuid={owner} value={targets} onChange={setTargets} />

      <ChangeNoteField id="ct-note" value={note} onChange={setNote} />

      {editing && latest === null && !conflict && changedFields.length + (targetsChanged ? 1 : 0) > 0 && (
        <OtherChangesPreview base={base!} content={content} targets={targets} unitName={unitName} />
      )}

      <DialogFooter className="items-center gap-2">
        {reason && (
          <p id="ct-save-reason" className="mr-auto text-[13px] text-[var(--muted)]">
            {reason}
          </p>
        )}
        <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
          Annuller
        </Button>
        <Button
          type="submit"
          disabled={reason !== null || saving}
          aria-describedby={reason ? 'ct-save-reason' : undefined}
        >
          {saving ? 'Gemmer …' : editing ? 'Gem ændringer' : 'Opret skabelon'}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Summary of what this save will change, so the change note can describe it accurately. */
function OtherChangesPreview({
  base,
  content,
  targets,
  unitName,
}: {
  base: CentralTemplateAdmin;
  content: CentralTemplateContent;
  targets: CentralTarget[];
  unitName: (uuid: string) => string;
}) {
  const fields = changedContentFields(contentOf(base), content);
  const t = diffTargets(base.targets, targets);
  const lines = [
    ...fields.map((f) => `${contentFieldLabels[f]} ændres`),
    ...t.added.map((x) => `Modtager tilføjes: ${unitName(x.orgUnitUuid)}`),
    ...t.removed.map((x) => `Modtager fjernes: ${unitName(x.orgUnitUuid)}`),
    ...t.changed.map((x) => `Underenheder ændres for: ${unitName(x.orgUnitUuid)}`),
  ];
  if (lines.length === 0) return null;
  return (
    <section aria-label="Dette gemmer du" className="text-[13px] text-[var(--ink-2)]">
      <p className="font-medium">Dette gemmer du</p>
      <ul className="list-disc pl-5">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </section>
  );
}
