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
  /**
   * `global` — shown once ever, then never again until the user asks for the
   * tour again with the "?" button. Right for anything that explains how the
   * product works: once you know it, you know it.
   *
   * `per-meeting` — shown once for each meeting. Only right for a warning about
   * THIS meeting's state, where the cost of not seeing it again is losing data.
   * An explainer scoped this way reappears on every new recording, which is how
   * "the recording is only stored in your browser" came back every time.
   *
   * OnboardingHint honours this; a `meetingId` passed at a `global` step is
   * ignored, so the registry and the call sites cannot drift apart.
   */
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
    copy: 'Klik her for at starte optagelsen. Vi guider dig gennem de næste trin, herunder at give adgang til mikrofonen.',
  },
  'dashboard.teams-link': {
    id: 'dashboard.teams-link',
    cluster: 'dashboard-nav',
    severity: 'high',
    scope: 'global',
    placement: 'top',
    engine: 'popover',
    copy: 'Indsæt et Teams-mødelink, så klarer OS2taletiltekst resten. Lyden hentes automatisk fra Teams, og du kan gennemgå referatudkastet, kort efter mødet er slut. Husk at lukke botten ind, hvis mødet har et venteværelse.',
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
    copy: 'Her finder du alle dine møder og skabeloner samlet ét sted.\n\nI fanen Møder kan du finde tidligere referater samt generere nye referater.\n\nI fanen Skabeloner kan du oprette nye skabeloner eller redigere eksisterende, så fremtidige referater får den ønskede struktur.',
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
    scope: 'global',
    placement: 'bottom',
    engine: 'popover',
    copy: 'Du finder disse indstillinger igen under fanen Eksport.',
  },
  'meeting-settings.redact-purpose': {
    id: 'meeting-settings.redact-purpose',
    cluster: 'meeting-creation',
    severity: 'high',
    scope: 'global',
    placement: 'top',
    engine: 'popover',
    copy: 'Brug denne funktion, når referatet er færdigt, og I ikke længere har brug for lyd og rå transskription — f.eks. for at overholde regler om sletning af persondata.',
  },
  'meeting-settings.redact-redirect': {
    id: 'meeting-settings.redact-redirect',
    cluster: 'meeting-creation',
    severity: 'low',
    scope: 'global',
    placement: 'top',
    engine: 'tooltip',
    copy: 'Indholdet slettes nu, og du sendes til arkivet.',
  },

  // ── Recording flow ──────────────────────────────────────────────────────
  'recording.start-button': {
    id: 'recording.start-button',
    cluster: 'recording',
    severity: 'high',
    scope: 'global',
    placement: 'top',
    engine: 'popover',
    copy: 'Tryk her for at starte optagelsen. Din browser beder om adgang til mikrofonen — optagelsen starter med det samme, du siger ja.',
  },
  'recording.pause-button': {
    id: 'recording.pause-button',
    cluster: 'recording',
    severity: 'medium',
    scope: 'global',
    placement: 'top',
    engine: 'popover',
    copy: 'Pauser optagelsen uden at afslutte den. Når du er klar, kan du fortsætte ved at klikke på knappen igen.',
  },
  'recording.stop-save-continue': {
    id: 'recording.stop-save-continue',
    cluster: 'recording',
    severity: 'high',
    scope: 'global',
    placement: 'top',
    engine: 'popover',
    copy: 'Stopper optagelsen og sender dig videre til Gennemgang.',
  },
  'recording.clarify-panel': {
    id: 'recording.clarify-panel',
    cluster: 'recording',
    severity: 'medium',
    scope: 'global',
    placement: 'left',
    engine: 'popover',
    copy: 'Forslag til emner og spørgsmål, der kan være værd at få afklaret. Listen opdateres løbende ud fra samtalen.',
  },
  'recording.audio-lifecycle': {
    id: 'recording.audio-lifecycle',
    cluster: 'recording',
    severity: 'medium',
    scope: 'global',
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
    scope: 'global',
    placement: 'left',
    engine: 'popover',
    copy: 'Markér de oplysninger, der skal skjules i referatet. Fjern fluebenet for at beholde teksten som den er.',
  },
  'review.skabelon-panel': {
    id: 'review.skabelon-panel',
    cluster: 'review-minutes',
    severity: 'high',
    scope: 'global',
    placement: 'left',
    engine: 'popover',
    copy: 'Start med at vælge en skabelon. Tilpas den ved at tilføje kategorier eller mødespecifikke instruktioner, så referatet passer til netop dette møde.',
  },
  'review.generate-button': {
    id: 'review.generate-button',
    cluster: 'review-minutes',
    severity: 'high',
    scope: 'global',
    placement: 'top',
    engine: 'popover',
    copy: 'Klik for at generere referatet ud fra den valgte skabelon. Bemærk: Lydfilen slettes automatisk, når referatet genereres, og kan ikke gendannes.',
  },
  'review.speaker-assign': {
    id: 'review.speaker-assign',
    cluster: 'review-minutes',
    severity: 'medium',
    scope: 'global',
    placement: 'right',
    engine: 'popover',
    copy: 'Knyt navn til stemmer, så de vises korrekt i referatet.',
  },
  'review.unknown-voices': {
    id: 'review.unknown-voices',
    cluster: 'review-minutes',
    severity: 'medium',
    scope: 'global',
    placement: 'right',
    engine: 'popover',
    copy: 'Der er stadig stemmer, der ikke er knyttet til en deltager. Klik for at navngive dem, så de kommer med i referatet.',
  },
  'review.chapter-title-edit': {
    id: 'review.chapter-title-edit',
    cluster: 'review-minutes',
    severity: 'low',
    scope: 'global',
    placement: 'top',
    engine: 'tooltip',
    copy: 'Klik på en kapiteloverskrift for at omdøbe den.',
  },
  'minutes.save-version': {
    id: 'minutes.save-version',
    cluster: 'review-minutes',
    severity: 'medium',
    scope: 'global',
    placement: 'bottom',
    engine: 'popover',
    copy: 'Gem en version af referatet, så du nemt kan vende tilbage til denne udgave senere.',
  },
  'minutes.version-dropdown': {
    id: 'minutes.version-dropdown',
    cluster: 'review-minutes',
    severity: 'low',
    scope: 'global',
    placement: 'bottom',
    engine: 'popover',
    copy: 'Se og skift mellem dine versioner af referatet.',
  },

  // ── Export/share + skabelon import ──────────────────────────────────────
  'export.post-download-link': {
    id: 'export.post-download-link',
    cluster: 'export-share',
    severity: 'medium',
    scope: 'global',
    placement: 'top',
    engine: 'tooltip',
    copy: 'Referatet er nu gemt i arkivet.',
  },
  'share.terminology-bridge': {
    id: 'share.terminology-bridge',
    cluster: 'export-share',
    severity: 'low',
    scope: 'global',
    placement: 'top',
    engine: 'popover',
    copy: 'Eksportér referatet som PDF eller Markdown, så det er klar til deling.',
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
  // Own keys only: 'constructor', 'toString' etc. are inherited from Object.prototype,
  // not real steps, and would otherwise resolve here instead of failing loudly.
  const step = Object.prototype.hasOwnProperty.call(ONBOARDING_STEPS, id) ? ONBOARDING_STEPS[id] : undefined;
  if (!step) throw new Error(`Unknown onboarding step id: ${id}`);
  return step;
}

/**
 * Non-throwing lookup for OnboardingHint/OnboardingTooltip: both wrap real page
 * content (e.g. a download button), so a typo'd stepId must not crash `children`
 * along with the hint. Logs so the mistake is still visible in review/testing.
 */
export function findStep(id: string): OnboardingStep | undefined {
  const step = Object.prototype.hasOwnProperty.call(ONBOARDING_STEPS, id) ? ONBOARDING_STEPS[id] : undefined;
  if (!step) console.error(`[onboarding] unknown step id: ${id}`);
  return step;
}
