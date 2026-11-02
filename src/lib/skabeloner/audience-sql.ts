// SQL building blocks shared by the two sides of "who holds a role/group": the recipient predicate
// (resolve.ts, who GETS a central template) and the holders count (central.ts, how many people a
// role/group target reaches), so the two cannot drift apart.

export const SCHEMA_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `"schema".table`; the schema is a trusted constant, but is validated anyway. */
export function qualifyTable(schema: string, table: string): string {
  if (!SCHEMA_RE.test(schema)) throw new Error('invalid schema name');
  return `"${schema}".${table}`;
}

/**
 * The conditions under which the claim row `ur` (public.user_external_roles) counts as held: claims
 * are on (`fresh` is a placeholder carrying the freshness in seconds; null = nobody holds anything),
 * the row is younger than that, and its user is a linked, non-disabled directory user (the same gate
 * as the org-unit branch). The catalogue's `active` flag is NOT part of it: the recipient predicate
 * adds it, the holders count deliberately does not (an inactive entry still shows who holds it).
 */
export function heldRoleSql(t: (table: string) => string, ur: string, fresh: string): string {
  return `${fresh}::int IS NOT NULL
       AND ${ur}.seen_at > now() - make_interval(secs => ${fresh}::int)
       AND EXISTS (SELECT 1 FROM ${t('directory_users')} d WHERE d.app_user_id = ${ur}.user_id AND d.disabled = false)`;
}
