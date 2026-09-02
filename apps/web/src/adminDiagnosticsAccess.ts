export const DIAGNOSTICS_BOOTSTRAP_USERNAME = 'denis';

/** Detailed voice reports are intentionally narrower than ordinary admin moderation access. */
export function canViewVoiceDiagnostics(user: { username?: string } | null | undefined): boolean {
  return user?.username === DIAGNOSTICS_BOOTSTRAP_USERNAME;
}
