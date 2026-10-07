// What the installation itself did, as opposed to what a person did. Today only the
// configuration fingerprint: everything is configured through the environment (no
// UI), so a change shows up as a different fingerprint at the next start. The
// fingerprint is a short hash over setting NAMES and non-secret values; it can say
// "something changed", never what, and never a secret.
import { z } from 'zod';
import { defineEvent } from './types';

export const systemEvents = {
  'system.config_changed': defineEvent({
    sources: ['system'],
    entityType: null,
    entityIdRequired: false,
    details: z
      .object({
        // First 16 hex characters of a sha256 over the non-secret effective configuration.
        fingerprint: z.string().regex(/^[0-9a-f]{16}$/),
        // false = the first fingerprint ever stored (the baseline), true = it differs from the stored one.
        changed: z.boolean(),
      })
      .strict(),
  }),
} as const;
