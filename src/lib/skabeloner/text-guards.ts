// Text guards shared by the server schemas (central-schemas.ts) and the personal change-note parser
// (change-note.ts). Free of zod and server imports: change-note.ts is bundled into the client.

/** Postgres text and jsonb cannot hold U+0000; left to the database it surfaces as a 500. */
export const noNul = (v: string): boolean => !v.includes('\u0000');

/**
 * A lone surrogate (an unpaired half of a UTF-16 pair) cannot be encoded as UTF-8 JSON and Postgres
 * jsonb rejects it (SQLSTATE 22P02). In u-mode a valid pair is one astral code point, so \p{Cs} only
 * matches a lone half.
 */
export const wellFormed = (v: string): boolean => !/\p{Cs}/u.test(v);
