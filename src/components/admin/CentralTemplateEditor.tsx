'use client';

import { useEffect, useMemo, useState } from 'react';
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
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { CENTRAL_LIMITS, diffPrincipals, principalKey, principalsEqual } from '@/lib/skabeloner/central-types';
import type {
  CentralCatalogueEntry,
  CentralPrincipalTargetView,
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
  principalKindLabels,
  type SharingSource,
  targetsEqual,
  unitNameLookup,
  viewAgainstCatalogue,
} from './central-template-utils';
import { OrgUnitTargetPicker } from './OrgUnitTargetPicker';
import { PrincipalTargetPicker } from './PrincipalTargetPicker';
import { PromptDiff } from './TemplateVersionHistory';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = create a new central template. */
  template: CentralTemplateAdmin | null;
  /** Every org unit (the audience picker); empty in claims mode, which has none. */
  units: CentralScopeOrgUnit[];
  /** The role/group catalogue for the role/group picker. */
  catalogue?: CentralCatalogueEntry[];
  /** false: the catalogue could not be loaded, so `catalogue` says nothing about a target (its server-side state is shown instead). Default true. */
  catalogueLoaded?: boolean;
  /** May role/group targets be changed: only in claims mode (the server enforces the same). Default false. */
  canTargetPrincipals?: boolean;
  /** Why role/group targets cannot be changed: roles only exist in claims mode. */
  targetLockedReason?: 'needs_claims' | null;
  /** The server's access mode; makes the locked role/group picker say which sharing route applies. */
  accessSource?: SharingSource | null;
  onSaved: () => void;
}

export function CentralTemplateEditor({
  open,
  onOpenChange,
  template,
  units,
  catalogue = [],
  catalogueLoaded = true,
  canTargetPrincipals = false,
  targetLockedReason = null,
  accessSource = null,
  onSaved,
}: Props) {
  // The form reports whether it holds unsaved text and whether a save is in flight. While either
  // is true the dialog cannot be dismissed by Escape or an outside click, and a dirty form asks
  // before it is closed by any other route (Annuller): a long prompt and note are not thrown away
  // silently, and a request in flight is not orphaned.
  const [guard, setGuard] = useState({ dirty: false, saving: false });
  const [confirming, setConfirming] = useState(false);

  function requestClose() {
    if (guard.saving) return;
    if (guard.dirty) setConfirming(true);
    else onOpenChange(false);
  }

  function blockDismiss(ev: Event) {
    if (!guard.dirty && !guard.saving) return; // nothing to lose: let Radix close it
    ev.preventDefault();
    requestClose();
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
        <DialogContent
          className="max-h-[92vh] max-w-2xl overflow-y-auto"
          onEscapeKeyDown={blockDismiss}
          onInteractOutside={blockDismiss}
        >
          <EditorForm
            template={template}
            units={units}
            catalogue={catalogue}
            catalogueLoaded={catalogueLoaded}
            canTargetPrincipals={canTargetPrincipals}
            targetLockedReason={targetLockedReason}
            accessSource={accessSource}
            onClose={() => onOpenChange(false)}
            onRequestClose={requestClose}
            onGuardChange={(dirty, saving) => setGuard((g) => (g.dirty === dirty && g.saving === saving ? g : { dirty, saving }))}
            onSaved={onSaved}
          />
        </DialogContent>
      </Dialog>
      <Dialog open={open && confirming} onOpenChange={setConfirming}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Kassér ændringer?</DialogTitle>
            <DialogDescription>
              Du har ikke gemt dine ændringer. Hvis du lukker nu, mister du den tekst, du har skrevet.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => setConfirming(false)}>
              Fortsæt redigering
            </Button>
            <Button
              type="button"
              onClick={() => {
                setConfirming(false);
                onOpenChange(false);
              }}
            >
              Kassér og luk
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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
  catalogue,
  catalogueLoaded,
  canTargetPrincipals,
  targetLockedReason,
  accessSource,
  onClose,
  onRequestClose,
  onGuardChange,
  onSaved,
}: {
  template: CentralTemplateAdmin | null;
  units: CentralScopeOrgUnit[];
  catalogue: CentralCatalogueEntry[];
  catalogueLoaded: boolean;
  canTargetPrincipals: boolean;
  targetLockedReason: 'needs_claims' | null;
  accessSource: SharingSource | null;
  /** Closes at once (after a successful save). */
  onClose: () => void;
  /** Closes on the user's request: asks first when there is unsaved text. */
  onRequestClose: () => void;
  onGuardChange: (dirty: boolean, saving: boolean) => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  // What the edit is based on. Replaced only by an explicit reload after a conflict.
  const [base, setBase] = useState<CentralTemplateAdmin | null>(template);
  const [content, setContent] = useState<CentralTemplateContent>(() => contentOf(template));
  const [targets, setTargets] = useState<CentralTarget[]>(() => template?.targets ?? []);
  const catalogueByKey = useMemo(() => new Map(catalogue.map((e) => [principalKey(e), e])), [catalogue]);
  // Names and states come from the catalogue when it knows the entry; a target it does not know is flagged.
  // When the catalogue itself failed to load it knows nothing, so the server's own state of the target
  // is kept instead of flagging everything "ukendt/inaktiv".
  const asViews = (list: readonly CentralPrincipalTargetView[]) =>
    catalogueLoaded ? list.map((t) => viewAgainstCatalogue(t, catalogueByKey)) : [...list];
  const [principals, setPrincipals] = useState<CentralPrincipalTargetView[]>(() => asViews(template?.principalTargets ?? []));
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  // Set by a 409: the saved version moved on; saving stays blocked until the user has reloaded.
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<CentralTemplateAdmin | null>(null);
  const [reloading, setReloading] = useState(false);

  const editing = template !== null;
  const unitName = useMemo(() => unitNameLookup(units), [units]);
  // The unit picker is hidden without org units (claims mode); then it cannot warn about an empty audience.
  const unitPickerShown = units.length > 0;

  const set = <K extends keyof CentralTemplateContent>(key: K, value: CentralTemplateContent[K]) =>
    setContent((c) => ({ ...c, [key]: value }));

  const changedFields = base ? changedContentFields(contentOf(base), content) : [];
  const targetsChanged = base ? !targetsEqual(base.targets, targets) : false;
  const principalsChanged = base ? !principalsEqual(base.principalTargets, principals) : false;
  const archivedNow = latest?.status === 'archived';

  // Unsaved text: anything typed into a new template, any difference from the loaded version of
  // an existing one, or a started change note.
  const dirty =
    note.trim() !== '' ||
    (editing
      ? changedFields.length > 0 || targetsChanged || principalsChanged
      : targets.length > 0 || principals.length > 0 || changedContentFields(EMPTY, content).length > 0);
  useEffect(() => onGuardChange(dirty, saving), [dirty, saving, onGuardChange]);

  // First blocking reason, shown next to the disabled save button.
  const reason = ((): string | null => {
    if (content.name.trim() === '') return 'Angiv et navn';
    if (content.prompt.trim() === '') return 'Angiv en prompt';
    if (editing && changedFields.length === 0 && !targetsChanged && !principalsChanged) return 'Ingen ændringer at gemme';
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
            ...(principalsChanged ? { principalTargets: principals.map(({ kind, identifier }) => ({ kind, identifier })) } : {}),
          },
        })
      : await apiRequest<{ template: CentralTemplateAdmin }>('/api/admin/central-templates', {
          method: 'POST',
          json: {
            ...content,
            targets,
            principalTargets: principals.map(({ kind, identifier }) => ({ kind, identifier })),
            changeNote: note.trim(),
          },
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
    setPrincipals(asViews(latest.principalTargets));
    setNote('');
    setConflict(false);
    setLatest(null);
  }

  const latestFields = latest ? changedContentFields(contentOf(latest), content) : [];
  const latestTargets = latest ? diffTargets(latest.targets, targets) : null;
  const latestPrincipalsDiffer = latest ? !principalsEqual(latest.principalTargets, principals) : false;

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{editing ? 'Rediger central skabelon' : 'Ny central skabelon'}</DialogTitle>
        <DialogDescription>
          Brugerne kan ikke ændre en central skabelon. Kun du og administratorer kan redigere den.
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
              (latestTargets.added.length || latestTargets.removed.length || latestTargets.changed.length) > 0) ||
            latestPrincipalsDiffer) && (
            <ul aria-label="Øvrige forskelle" className="list-disc pl-5 text-[13px] text-[var(--ink-2)]">
              {latestFields
                .filter((f) => f !== 'prompt')
                .map((f) => (
                  <li key={f}>{contentFieldLabels[f]} er forskellig fra den gemte version</li>
                ))}
              {((latestTargets && !targetsEqual(latest.targets, targets)) || latestPrincipalsDiffer) && (
                <li>Hvem der har skabelonen til rådighed er forskelligt fra den gemte version</li>
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
          placeholder="Kort beskrivelse, som brugerne ser"
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
          Brugerne kan bruge skabelonen, men de kan ikke se eller ændre prompten.
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

      {/* Without org units (claims mode) there is nothing to pick; the roles and groups below carry the audience. */}
      {unitPickerShown && (
        <OrgUnitTargetPicker
          units={units}
          value={targets}
          onChange={setTargets}
          hasOtherAudience={principals.length > 0}
        />
      )}

      {(canTargetPrincipals || principals.length > 0 || catalogue.length > 0) && (
        <PrincipalTargetPicker
          catalogue={catalogue}
          value={principals}
          onChange={setPrincipals}
          canEdit={canTargetPrincipals && catalogueLoaded}
          lockedReason={targetLockedReason}
          accessSource={accessSource}
          hasOtherAudience={targets.length > 0}
          warnWhenEmpty={!unitPickerShown}
        />
      )}

      <ChangeNoteField id="ct-note" value={note} onChange={setNote} />

      {editing && latest === null && !conflict && changedFields.length + (targetsChanged ? 1 : 0) + (principalsChanged ? 1 : 0) > 0 && (
        <OtherChangesPreview
          base={base!}
          content={content}
          targets={targets}
          principals={principals}
          unitName={unitName}
        />
      )}

      <DialogFooter className="items-center gap-2">
        {reason && (
          <p id="ct-save-reason" className="mr-auto text-[13px] text-[var(--muted)]">
            {reason}
          </p>
        )}
        <Button type="button" variant="outline" onClick={onRequestClose} disabled={saving}>
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
  principals,
  unitName,
}: {
  base: CentralTemplateAdmin;
  content: CentralTemplateContent;
  targets: CentralTarget[];
  principals: CentralPrincipalTargetView[];
  unitName: (uuid: string) => string;
}) {
  const fields = changedContentFields(contentOf(base), content);
  const t = diffTargets(base.targets, targets);
  const p = diffPrincipals(base.principalTargets, principals);
  const lines = [
    ...fields.map((f) => `${contentFieldLabels[f]} ændres`),
    ...t.added.map(
      (x) => `Gøres tilgængelig for: ${unitName(x.orgUnitUuid)}${x.includeDescendants ? ' (inkl. underenheder)' : ''}`,
    ),
    ...t.removed.map((x) => `Ikke længere tilgængelig for: ${unitName(x.orgUnitUuid)}`),
    ...t.changed.map((x) => `Underenheder ændres for: ${unitName(x.orgUnitUuid)}`),
    ...p.added.map((x) => `Gøres tilgængelig for: ${x.name} (${principalKindLabels[x.kind].toLowerCase()})`),
    ...p.removed.map((x) => `Ikke længere tilgængelig for: ${x.name} (${principalKindLabels[x.kind].toLowerCase()})`),
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
