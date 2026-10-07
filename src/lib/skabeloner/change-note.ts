// The change-note counting rule, shared by the server schema (central-schemas.ts) and the
// admin UI's character counter, so the counter shows the number the server enforces. Keep
// this module free of zod and server imports: it is bundled into the client.

export const CHANGE_NOTE_MESSAGE = 'Beskriv ændringen (mindst 10 tegn)';

// Invisible characters would let a note of "nothing" satisfy the length rule: every
// Default_Ignorable code point (zero-width characters, soft hyphen, combining grapheme
// joiner, variation selectors, tag characters, Hangul fillers, ...), control and format
// characters, and the blank "letters" that render as empty (Hangul fillers, braille
// blank). Newlines, carriage returns and tabs are kept: the note is typed in a textarea.
// MEANINGLESS_CHARS_CLASS in src/lib/db/schema.ts mirrors this (plus White_Space) for the
// table CHECKs; change-note.test.ts derives the expected SQL class from this regex.
export const INVISIBLE_SOURCE =
  '(?![\\n\\r\\t])[\\p{Default_Ignorable_Code_Point}\\p{Cc}\\p{Cf}\\u115f\\u1160\\u2800\\u3164\\uffa0]';

/** Removes invisible characters and trims. */
export const stripInvisible = (v: string): string => v.replace(new RegExp(INVISIBLE_SOURCE, 'gu'), '').trim();

// Whitespace (spaces, NBSP, em space, line breaks) is kept in the stored text but never
// counts towards the minimum: "a" + nine spaces + "b" is not a ten character note.
// Counted in code points, not UTF-16 units: 5 emoji are 10 units but 5 characters.
export const meaningfulLength = (v: string): number => {
  let n = 0;
  for (const ch of v) if (!/\p{White_Space}/u.test(ch)) n++;
  return n;
};

/** The number that counts towards the minimum: strip, trim, drop whitespace, count code points. */
export const changeNoteLength = (note: string): number => meaningfulLength(stripInvisible(note));

/** Longest optional note on a PERSONAL template edit (free text for the person themselves). */
export const LOCAL_CHANGE_NOTE_MAX = 2000;

export type LocalChangeNote = { ok: true; note: string | null } | { ok: false; error: string };

/**
 * The OPTIONAL "what did you change" note of a personal template edit. Absent, null or blank
 * means no note (null); there is no minimum, unlike the mandatory note of a central template.
 * Stored only in the person's own schema; never audited or logged. NFC, invisible characters
 * stripped, NUL and lone surrogates (which Postgres text cannot hold) rejected.
 */
export function parseLocalChangeNote(raw: unknown): LocalChangeNote {
  if (raw === undefined || raw === null) return { ok: true, note: null };
  if (typeof raw !== 'string') return { ok: false, error: 'Ændringsbeskrivelsen skal være tekst' };
  if (raw.length > LOCAL_CHANGE_NOTE_MAX * 4) return { ok: false, error: tooLong() };
  if (raw.includes('\u0000') || /\p{Cs}/u.test(raw)) {
    return { ok: false, error: 'Ændringsbeskrivelsen indeholder ugyldige tegn' };
  }
  const note = stripInvisible(raw).normalize('NFC');
  if (note.length > LOCAL_CHANGE_NOTE_MAX) return { ok: false, error: tooLong() };
  return { ok: true, note: note === '' ? null : note };
}

function tooLong(): string {
  return `Ændringsbeskrivelsen er for lang (højst ${LOCAL_CHANGE_NOTE_MAX} tegn)`;
}
