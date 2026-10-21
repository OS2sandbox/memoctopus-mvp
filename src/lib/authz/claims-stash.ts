// Hand-over of the role/group claims of an OIDC login from the profile mapper (which
// sees the merged id_token + userinfo claims, but does not know the app user yet) to the
// login hook (which knows the user, but only has the id_token stored on the account).
// Both run inside ONE request in ONE process, so a short-lived in-memory map is enough;
// nothing is persisted here, entries expire after a minute, and the map is size-capped.
// What is held is only the claims the provider's role/group config reads (claimSubset).

const TTL_MS = 60_000;
const MAX_ENTRIES = 1000;

const stash = new Map<string, { claims: Record<string, unknown>; expiresAt: number }>();

const keyOf = (providerId: string, accountId: string) => `${providerId}\u0000${accountId}`;

function sweep(now: number): void {
  for (const [k, v] of stash) if (v.expiresAt <= now) stash.delete(k);
  // Still full of live entries: drop the oldest (Map keeps insertion order).
  while (stash.size >= MAX_ENTRIES) {
    const oldest = stash.keys().next();
    if (oldest.done) break;
    stash.delete(oldest.value);
  }
}

export function stashLoginClaims(providerId: string, accountId: string, claims: Record<string, unknown>): void {
  const now = Date.now();
  if (stash.size >= MAX_ENTRIES) sweep(now);
  stash.set(keyOf(providerId, accountId), { claims, expiresAt: now + TTL_MS });
}

/** Takes (and removes) the stashed claims; null when none or expired. */
export function takeLoginClaims(providerId: string, accountId: string): Record<string, unknown> | null {
  const key = keyOf(providerId, accountId);
  const hit = stash.get(key);
  stash.delete(key);
  return hit && hit.expiresAt > Date.now() ? hit.claims : null;
}

/** Test seam. */
export function clearLoginClaimsStash(): void {
  stash.clear();
}
