import { describe, expect, it } from 'vitest';
import { ROLLEKATALOG_ERROR_CODES } from './errors';
import { syncCountLabels, syncErrorMessage } from './labels.da';
import { SYNC_COUNT_KEYS } from './types';

describe('labels.da', () => {
  const GENERIC = 'Synkroniseringen mislykkedes. Intet er ændret.';

  it.each([...ROLLEKATALOG_ERROR_CODES, 'empty_response', 'removal_threshold', 'already_running', 'unexpected'])(
    'has a specific Danish message for %s that does not leak the code',
    (code) => {
      const msg = syncErrorMessage(code);
      expect(msg).not.toBe(GENERIC);
      expect(msg).not.toContain(code);
    },
  );

  it('falls back to a fixed generic text for unknown, null and undefined codes', () => {
    for (const c of ['nope', '', null, undefined, '__proto__', 'constructor']) expect(syncErrorMessage(c)).toBe(GENERIC);
  });

  it('labels every sync counter', () => {
    for (const k of SYNC_COUNT_KEYS) expect(syncCountLabels[k]).toBeTruthy();
  });
});
