// Danish wording for the Rollekatalog sync. Pure (no env,
// no server imports) so client components and routes share one source.
import type { SyncCounts } from './types';

const ERROR_MESSAGES: Record<string, string> = {
  not_configured: 'Rollekatalog er ikke konfigureret (adresse eller API-nøgler mangler).',
  insecure_url: 'Rollekatalog-adressen skal bruge https.',
  unauthorized: 'Rollekatalog afviste API-nøglen.',
  forbidden: 'API-nøglen har ikke de nødvendige rettigheder i Rollekatalog.',
  not_found: 'Rollekatalog kunne ikke finde det, der blev spurgt om.',
  timeout: 'Rollekatalog svarede ikke i tide.',
  network: 'Kunne ikke få forbindelse til Rollekatalog.',
  server_error: 'Rollekatalog svarede med en serverfejl.',
  invalid_response:
    'Svaret fra Rollekatalog havde et uventet format, eller for mange rækker i det var ugyldige. Intet er ændret. Kontrollér brugere og enheder i Rollekatalog (id\'er skal være gyldige uuid\'er).',
  too_large: 'Svaret fra Rollekatalog var for stort.',
  empty_response: 'Rollekatalog returnerede ingen brugere eller enheder. Synkroniseringen er afbrudt, og intet er ændret.',
  removal_threshold:
    'Synkroniseringen ville fjerne eller deaktivere usædvanligt mange brugere eller roller og er afbrudt. Intet er ændret. Kontrollér Rollekatalog, eller gennemtving synkroniseringen.',
  already_running: 'En synkronisering kører allerede.',
  unexpected: 'Der opstod en uventet fejl under synkroniseringen. Intet er ændret.',
};

const GENERIC = 'Synkroniseringen mislykkedes. Intet er ændret.';

/** The Danish message for a sync/client error code; a fixed generic text for anything unknown (never the raw code). */
export function syncErrorMessage(code: string | null | undefined): string {
  return code && Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code) ? ERROR_MESSAGES[code] : GENERIC;
}

export const syncStatusLabels: Record<'running' | 'success' | 'failed', string> = {
  running: 'Kører',
  success: 'Gennemført',
  failed: 'Mislykkedes',
};

export const syncCountLabels: Record<keyof SyncCounts, string> = {
  usersUpserted: 'Brugere opdateret',
  usersDisabled: 'Brugere deaktiveret',
  sessionsRevoked: 'Sessioner afsluttet',
  orgUnitsUpserted: 'Enheder opdateret',
  orgUnitsOrphaned: 'Enheder uden kendt overenhed',
  orgUnitCyclesBroken: 'Kredsløb i organisationen brudt',
  assignmentsUpserted: 'Roller opdateret',
  assignmentsRemoved: 'Roller fjernet',
  assignmentsIgnoredRole: 'Ukendte roller ignoreret',
  assignmentsSkippedUnknownUser: 'Roller for ukendte brugere sprunget over',
  assignmentsWithoutScope: 'Roller uden område (ikke tildelt)',
  usersSkippedInvalid: 'Brugere sprunget over (ugyldig række)',
  orgUnitsSkippedInvalid: 'Enheder sprunget over (ugyldig række)',
  assignmentRowsSkippedInvalid: 'Rolle-rækker sprunget over (ugyldig række)',
  membershipsSkippedInvalid: 'Stillinger sprunget over (ugyldig række)',
};

// The role catalogue refresh: its own wording where the sync's would be wrong (it reads roles
// and groups, not users and units), the sync's for every upstream error.
const CATALOGUE_MESSAGES: Record<string, string> = {
  empty_response:
    'Rollekatalog returnerede ingen roller eller grupper, eller den ene af listerne var tom, selvom den før havde indhold. Opdateringen er afbrudt, og kataloget er uændret. Kontrollér stierne til rollelisterne og Rollekatalog.',
  removal_threshold:
    'Opdateringen ville fjerne usædvanligt mange roller eller grupper fra kataloget og er afbrudt. Intet er ændret. Kontrollér Rollekatalog, eller gennemtving opdateringen.',
  invalid_response: 'Svaret fra Rollekatalog havde et uventet format, eller for mange rækker i det var ugyldige. Intet er ændret.',
  already_running: 'En opdatering af rollekataloget kører allerede.',
  db_error: 'Rollekataloget kunne ikke gemmes. Intet er ændret.',
  unexpected: 'Der opstod en uventet fejl under opdateringen af rollekataloget. Intet er ændret.',
};

export function catalogueErrorMessage(code: string | null | undefined): string {
  if (code && Object.prototype.hasOwnProperty.call(CATALOGUE_MESSAGES, code)) return CATALOGUE_MESSAGES[code];
  return syncErrorMessage(code);
}
