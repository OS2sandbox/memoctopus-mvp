// The one definition of a well-formed UUID (any case). Dependency-free, so client code can import it too.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/**
 * Route params and form fields are client-supplied and never verified against a
 * meeting, so an id only becomes an audit entity when it is a well-formed UUID;
 * anything else yields undefined (the event is then logged without an entity).
 * The value is returned as given: the audit writer lower-cases it.
 */
export function asEntityUuid(value: unknown): string | undefined {
  return isUuid(value) ? value : undefined;
}
