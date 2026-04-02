import { getRuntime, type RuntimeTranscriptEntry } from '@/lib/runtimes';

export function runtimeIdFromSessionKey(sessionKey: string): string | null {
  if (sessionKey.startsWith('claude-code:')) return 'claude-code';
  if (
    sessionKey.startsWith('codex:')
    || sessionKey.startsWith('codex-owned:')
    || sessionKey.startsWith('codex-discovered:')
  ) {
    return 'codex';
  }
  return null;
}

export async function readRuntimeTranscript(
  sessionKey: string,
  options: { sinceId?: string; limit?: number } = {},
): Promise<RuntimeTranscriptEntry[]> {
  const runtimeId = runtimeIdFromSessionKey(sessionKey);
  if (!runtimeId) {
    throw new Error(`Cannot determine runtime for session: ${sessionKey}`);
  }

  const adapter = getRuntime(runtimeId);
  if (!adapter?.capabilities.readTranscript) {
    throw new Error(`Runtime ${runtimeId} does not support transcript reading`);
  }

  return adapter.readTranscript(sessionKey, options.sinceId, options.limit);
}
