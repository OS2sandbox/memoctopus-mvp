// One wrapper around Intl.DateTimeFormat('da-DK') for every admin timestamp. Missing or
// unparseable input gives `fallback`, or the raw string when none is passed.
export function formatDateTime(
  iso: string | null,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'short', timeStyle: 'short' },
  fallback?: string,
): string {
  if (!iso) return fallback ?? '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fallback ?? iso;
  return new Intl.DateTimeFormat('da-DK', options).format(d);
}
