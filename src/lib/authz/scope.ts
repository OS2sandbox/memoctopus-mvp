// The org tree comes from synced or hand-entered data, so it can contain cycles. A walk
// over it (the template audience in src/lib/skabeloner/resolve.ts) therefore uses UNION
// (not UNION ALL) and this hard depth cap: bad data terminates, and anything deeper than
// the cap is treated as NOT covered (fail closed).
export const MAX_ORG_DEPTH = 64;
