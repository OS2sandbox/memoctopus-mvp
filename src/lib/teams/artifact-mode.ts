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

/**
 * Whether the recording Teams left in the organizer's OneDrive is deleted once it
 * has been transcribed. On unless explicitly "false": the platform's promise is
 * that no meeting audio outlives its transcription, and the copy in OneDrive only
 * exists because Memoctopus switched recording on.
 *
 * It costs a fourth delegated permission (`Files.ReadWrite`), which is why it can
 * be switched off — that also drops the scope from sign-in. Moot in
 * transcript-only mode, where no recording is fetched and so none can be matched.
 */
export function deleteRecordingEnabled(): boolean {
  if (artifactMode() === 'transcript-only') return false;
  return process.env.TEAMS_DELETE_RECORDING?.trim().toLowerCase() !== 'false';
}
