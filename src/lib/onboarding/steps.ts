// Single source of truth for onboarding hint content, decoupled from both the
// rendering engine (OnboardingHint/OnboardingTooltip) and the pages that
// reference a step by id. Copy is plain, direct Danish UI microcopy — not the
// formal /professionalize register, which is for written deliverables, not UI.
//
// `engine: 'tooltip'` steps are always-available explainers (not one-time
// onboarding) and never write to onboarding_progress — they render every time
// the anchor is hovered/focused, matching a plain tooltip's behavior.

export type OnboardingCluster =
  | 'dashboard-nav'
  | 'meeting-creation'
  | 'recording'
  | 'review-minutes'
  | 'export-share'
  | 'arkiv-skabeloner';

export type OnboardingStep = {
  id: string;
  cluster: OnboardingCluster;
  severity: 'high' | 'medium' | 'low';
  scope: 'global' | 'per-meeting';
  placement: 'top' | 'bottom' | 'left' | 'right';
  engine: 'popover' | 'tooltip';
  copy: string;
};

export const ONBOARDING_STEPS: Record<string, OnboardingStep> = {
  // ── Dashboard + nav ─────────────────────────────────────────────────────
  'dashboard.record-button': {
    id: 'dashboard.record-button',
    cluster: 'dashboard-nav',
    severity: 'high',
    scope: 'global',
    placement: 'top',
    engine: 'popover',
    copy: 'Klik her for at starte optagelsen med det samme. Din browser beder om adgang til mikrofonen lige efter.',
  },
  'dashboard.teams-link': {
    id: 'dashboard.teams-link',
    cluster: 'dashboard-nav',
    severity: 'high',
    scope: 'global',
    placement: 'top',
    engine: 'popover',
    copy: 'Indsæt et Teams-mødelink her, så deltager en bot automatisk i mødet og optager det for dig. Husk at lukke botten ind, hvis mødet har et venteværelse.',
  },
  'dashboard.keyboard-shortcuts': {
    id: 'dashboard.keyboard-shortcuts',
    cluster: 'dashboard-nav',
    severity: 'medium',
    scope: 'global',
    placement: 'bottom',
    engine: 'tooltip',
    copy: 'Genvej: tryk R for at starte en optagelse, eller U for at uploade en lydfil.',
  },
  'dashboard.participant-chip': {
    id: 'dashboard.participant-chip',
    cluster: 'dashboard-nav',
    severity: 'low',
    scope: 'global',
    placement: 'top',
    engine: 'popover',
    copy: 'Skriv et navn, og tryk Enter for at tilføje deltageren.',
  },
  'topbar.unsaved-audio': {
    id: 'topbar.unsaved-audio',
    cluster: 'dashboard-nav',
    severity: 'high',
    scope: 'per-meeting',
    placement: 'bottom',
    engine: 'popover',
    copy: 'Du har stadig en optagelse gemt lokalt for dette møde. Går du videre til Arkiv, bliver lydfilen slettet — men transskriptionen kan du altid finde igen der, uanset om referatet er færdigt.',
  },
  'topbar.arkiv-explainer': {
    id: 'topbar.arkiv-explainer',
    cluster: 'dashboard-nav',
    severity: 'low',
    scope: 'global',
    placement: 'bottom',
    engine: 'popover',
    copy: 'Her samler vi alle dine møder, optagelser og referater, så snart du har afsluttet det første.',
  },

  // ── Meeting creation + settings ─────────────────────────────────────────
  'meeting-new.upload-mode': {
    id: 'meeting-new.upload-mode',
    cluster: 'meeting-creation',
    severity: 'high',
    scope: 'global',
    placement: 'top',
    engine: 'popover',
    copy: 'Så snart du vælger en fil, går den i gang med at blive transskriberet. Du kan navngive mødet og tilføje deltagere bagefter.',
  },
  'meeting-new.record-mic-permission': {
    id: 'meeting-new.record-mic-permission',
    cluster: 'meeting-creation',
    severity: 'medium',
    scope: 'global',
    placement: 'top',
    engine: 'popover',
    copy: 'Din browser beder om adgang til mikrofonen, når du klikker — godkend for at optagelsen kan starte.',
  },
  'meeting-new.participants-field': {
    id: 'meeting-new.participants-field',
    cluster: 'meeting-creation',
    severity: 'low',
    scope: 'global',
    placement: 'top',
    engine: 'popover',
    copy: 'Deltagerne du skriver her, vises automatisk i det færdige referat.',
  },
  'meeting-settings.processstrip-export': {
    id: 'meeting-settings.processstrip-export',
    cluster: 'meeting-creation',
    severity: 'medium',
    scope: 'per-meeting',
    placement: 'bottom',
    engine: 'popover',
    copy: 'Du finder disse indstillinger igen under fanen Eksport.',
  },
  'meeting-settings.redact-purpose': {
    id: 'meeting-settings.redact-purpose',
    cluster: 'meeting-creation',
    severity: 'high',
    scope: 'per-meeting',
    placement: 'top',
    engine: 'popover',
    copy: 'Brug denne funktion, når referatet er færdigt, og I ikke længere har brug for lyd og rå transskription — f.eks. for at overholde regler om sletning af persondata.',
  },
  'meeting-settings.redact-redirect': {
    id: 'meeting-settings.redact-redirect',
    cluster: 'meeting-creation',
    severity: 'low',
    scope: 'per-meeting',
    placement: 'top',
    engine: 'tooltip',
    copy: 'Indholdet slettes nu, og du sendes til arkivet.',
  },

  // ── Recording flow ──────────────────────────────────────────────────────
  'recording.start-button': {
    id: 'recording.start-button',
    cluster: 'recording',
    severity: 'high',
    scope: 'per-meeting',
    placement: 'top',
    engine: 'popover',
    copy: 'Tryk her for at starte optagelsen. Din browser beder om adgang til mikrofonen — optagelsen starter med det samme, du siger ja.',
  },
  'recording.stop-save-continue': {
    id: 'recording.stop-save-continue',
    cluster: 'recording',
    severity: 'high',
    scope: 'per-meeting',
    placement: 'top',
    engine: 'popover',
    copy: 'Stopper optagelsen her og gemmer den. Du sendes videre til Gennemgang, hvor transskriptionen bliver klar.',
  },
  'recording.clarify-panel': {
    id: 'recording.clarify-panel',
    cluster: 'recording',
    severity: 'medium',
    scope: 'per-meeting',
    placement: 'left',
    engine: 'popover',
    copy: 'Her foreslår AI’en spørgsmål, I bør få afklaret i mødet, ud fra det, der er sagt indtil nu. Brug dem som en live-huskeliste — de opdateres automatisk undervejs.',
  },
  'recording.audio-lifecycle': {
    id: 'recording.audio-lifecycle',
    cluster: 'recording',
    severity: 'medium',
    scope: 'per-meeting',
    placement: 'bottom',
    engine: 'popover',
    copy: 'Optagelsen gemmes kun lokalt i din browser. Den bruges til at lave transskription og referat og slettes automatisk bagefter.',
  },
  'recording.signal-bars': {
    id: 'recording.signal-bars',
    cluster: 'recording',
    severity: 'low',
    scope: 'global',
    placement: 'bottom',
    engine: 'tooltip',
    copy: 'Bjælkerne viser, hvor meget lyd mikrofonen opfanger lige nu — brug dem til at tjekke, at mikrofonen virker.',
  },
  'recording.star-marker': {
    id: 'recording.star-marker',
    cluster: 'recording',
    severity: 'low',
    scope: 'global',
    placement: 'top',
    engine: 'tooltip',
    copy: 'Denne markering er kun en visuel indikator for, at linjen er skrevet live — den kan trygt ignoreres.',
  },

  // ── Review + minutes ─────────────────────────────────────────────────────
  'review.pii-checkboxes': {
    id: 'review.pii-checkboxes',
    cluster: 'review-minutes',
    severity: 'high',
    scope: 'per-meeting',
    placement: 'left',
    engine: 'popover',
    copy: 'Markér de oplysninger, der skal skjules i referatet. Fjern fluebenet for at beholde teksten som den er.',
  },
  'review.skabelon-panel': {
    id: 'review.skabelon-panel',
    cluster: 'review-minutes',
    severity: 'high',
    scope: 'per-meeting',
    placement: 'left',
    engine: 'popover',
    copy: 'Vælg hvilke afsnit referatet skal have, og skriv evt. ekstra instruktioner nedenfor — de bruges sammen med skabelonen, når referatet genereres.',
  },
  'review.generate-button': {
    id: 'review.generate-button',
    cluster: 'review-minutes',
    severity: 'high',
    scope: 'per-meeting',
    placement: 'top',
    engine: 'popover',
    copy: 'Bemærk: Lydfilen slettes automatisk, når referatet genereres, og kan ikke gendannes. Sørg for at gennemgangen er færdig først.',
  },
  'review.speaker-assign': {
    id: 'review.speaker-assign',
    cluster: 'review-minutes',
    severity: 'medium',
    scope: 'per-meeting',
    placement: 'right',
    engine: 'popover',
    copy: 'Klik for at høre stemmen, og vælg derefter hvem den tilhører. Alle den persons replikker bliver navngivet med det samme.',
  },
  'review.unknown-voices': {
    id: 'review.unknown-voices',
    cluster: 'review-minutes',
    severity: 'medium',
    scope: 'per-meeting',
    placement: 'right',
    engine: 'popover',
    copy: 'Der er stadig stemmer, der ikke er knyttet til en deltager. Klik for at navngive dem, så de kommer med i referatet.',
  },
  'review.chapter-title-edit': {
    id: 'review.chapter-title-edit',
    cluster: 'review-minutes',
    severity: 'low',
    scope: 'per-meeting',
    placement: 'top',
    engine: 'tooltip',
    copy: 'Klik på en kapiteloverskrift for at omdøbe den.',
  },
  'minutes.save-version': {
    id: 'minutes.save-version',
    cluster: 'review-minutes',
    severity: 'medium',
    scope: 'per-meeting',
    placement: 'bottom',
    engine: 'popover',
    copy: 'Dine rettelser gemmes automatisk løbende. Klik Gem version, hvis du vil kunne vende tilbage til denne udgave senere.',
  },
  'minutes.version-dropdown': {
    id: 'minutes.version-dropdown',
    cluster: 'review-minutes',
    severity: 'low',
    scope: 'per-meeting',
    placement: 'bottom',
    engine: 'popover',
    copy: 'Du har nu flere versioner. Klik her for at se og skifte mellem dem.',
  },

  // ── Export/share + skabelon import ──────────────────────────────────────
  'export.audio-deleted-timing': {
    id: 'export.audio-deleted-timing',
    cluster: 'export-share',
    severity: 'high',
    scope: 'per-meeting',
    placement: 'top',
    engine: 'popover',
    copy: 'Lydfilen er allerede slettet — det sker automatisk, når referatet dannes, ikke når du trykker download. Selve transskriptionen ligger fortsat i arkivet.',
  },
  'export.post-download-link': {
    id: 'export.post-download-link',
    cluster: 'export-share',
    severity: 'medium',
    scope: 'per-meeting',
    placement: 'top',
    engine: 'tooltip',
    copy: 'Referatet er nu gemt i arkivet.',
  },
  'share.terminology-bridge': {
    id: 'share.terminology-bridge',
    cluster: 'export-share',
    severity: 'low',
    scope: 'per-meeting',
    placement: 'top',
    engine: 'popover',
    copy: 'Sådan deler du referatet: eksportér det som PDF eller Markdown, og send filen videre til dine kolleger.',
  },
  'skabelon-import.explainer': {
    id: 'skabelon-import.explainer',
    cluster: 'export-share',
    severity: 'medium',
    scope: 'global',
    placement: 'bottom',
    engine: 'popover',
    copy: 'En skabelon er en genbrugelig opskrift til dine referater. Når du importerer den, får du din egen kopi, som du frit kan redigere uden at ændre originalen.',
  },
  'skabelon-import.error-next-steps': {
    id: 'skabelon-import.error-next-steps',
    cluster: 'export-share',
    severity: 'medium',
    scope: 'global',
    placement: 'bottom',
    engine: 'tooltip',
    copy: 'Bed den, der delte det, om et nyt link — eller gå til dine egne skabeloner.',
  },
  'skabelon-import.idempotency': {
    id: 'skabelon-import.idempotency',
    cluster: 'export-share',
    severity: 'low',
    scope: 'global',
    placement: 'top',
    engine: 'popover',
    copy: 'Import opretter en ny kopi hver gang. Tjek dine skabeloner under Arkiv, hvis du er i tvivl om, du allerede har hentet denne.',
  },

  // ── Arkiv + skabeloner ───────────────────────────────────────────────────
  'arkiv.delete-button-touch': {
    id: 'arkiv.delete-button-touch',
    cluster: 'arkiv-skabeloner',
    severity: 'high',
    scope: 'global',
    placement: 'left',
    engine: 'tooltip',
    copy: 'Hold musen over et møde for at se slet-knappen. På mobil: brug “Rediger arkiv” for at slette.',
  },
  'arkiv.bulk-edit-button': {
    id: 'arkiv.bulk-edit-button',
    cluster: 'arkiv-skabeloner',
    severity: 'medium',
    scope: 'global',
    placement: 'bottom',
    engine: 'popover',
    copy: 'Klik her for at vælge flere møder og slette dem samlet.',
  },
  'skabeloner.tab-purpose': {
    id: 'skabeloner.tab-purpose',
    cluster: 'arkiv-skabeloner',
    severity: 'high',
    scope: 'global',
    placement: 'bottom',
    engine: 'popover',
    copy: 'Skabeloner styrer, hvordan dine referater bliver skrevet. Klik på stjernen for at gøre en skabelon til standard — den bruges automatisk, når du opretter et nyt referat.',
  },
  'skabeloner.category-helper': {
    id: 'skabeloner.category-helper',
    cluster: 'arkiv-skabeloner',
    severity: 'medium',
    scope: 'global',
    placement: 'top',
    engine: 'tooltip',
    copy: 'Vælg hvilke afsnit dit referat altid skal indeholde, uanset hvad der bliver sagt til mødet.',
  },
  'skabeloner.share-button': {
    id: 'skabeloner.share-button',
    cluster: 'arkiv-skabeloner',
    severity: 'low',
    scope: 'global',
    placement: 'top',
    engine: 'popover',
    copy: 'Del-knappen kopierer en kode eller et link, som andre kan indsætte under “Ny skabelon” for at få din skabelon.',
  },
};

export function getStep(id: string): OnboardingStep {
  const step = ONBOARDING_STEPS[id];
  if (!step) throw new Error(`Unknown onboarding step id: ${id}`);
  return step;
}

/**
 * Non-throwing lookup for OnboardingHint/OnboardingTooltip: both wrap real page
 * content (e.g. a download button), so a typo'd stepId must not crash `children`
 * along with the hint. Logs so the mistake is still visible in review/testing.
 */
export function findStep(id: string): OnboardingStep | undefined {
  const step = ONBOARDING_STEPS[id];
  if (!step) console.error(`[onboarding] unknown step id: ${id}`);
  return step;
}
