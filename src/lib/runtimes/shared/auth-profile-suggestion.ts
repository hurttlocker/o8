import type {
  MachineAuthProfileSuggestion,
  RuntimeAuthStatus,
  RuntimeHouse,
} from './auth-detect';

export function suggestMachineAuthProfile(
  statuses: Record<RuntimeHouse, RuntimeAuthStatus>,
): MachineAuthProfileSuggestion {
  // `ready` is the usability verdict; `authenticated` is credential evidence only.
  // Gateway-backed workers can be ready without native credential evidence.
  const codexReady = statuses.codex.installed && statuses.codex.ready;
  const claudeReady = statuses.claude.installed && statuses.claude.ready;
  if (codexReady && !claudeReady) {
    return { profile: 'codex-only', detail: 'Only Codex is signed in on this machine.' };
  }
  if (claudeReady && !codexReady) {
    return { profile: 'claude-only', detail: 'Only Claude Code is signed in on this machine.' };
  }
  return { profile: null, detail: null };
}
