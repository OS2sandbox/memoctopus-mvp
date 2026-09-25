// Env-only and import-free, so src/lib/auth/providers.ts can read it without
// pulling in the pipeline (which imports graph-client, which imports auth).

export type ArtifactMode = 'prefer-recording' | 'transcript-only';

/**
 * Deployment-wide artifact policy. `transcript-only` is for customers who forbid
 * recordings: Teams' own transcript is used verbatim and no mp4 is ever fetched.
 */
export function artifactMode(): ArtifactMode {
  const raw = process.env.TEAMS_ARTIFACT_MODE?.trim().toLowerCase() || undefined;
  return raw === 'transcript-only' ? 'transcript-only' : 'prefer-recording';
}
