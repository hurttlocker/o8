import { getRuntime, type RuntimeTranscriptEntry } from '@/lib/runtimes';

export function runtimeIdFromSessionKey(sessionKey: string): string | null {
  const separatorIndex = sessionKey.indexOf(':');
  if (separatorIndex <= 0) return null;
  const prefix = sessionKey.slice(0, separatorIndex).trim();
  if (!prefix) return null;
  const runtimeId = prefix.replace(/-(?:owned|discovered)$/, '');
  return getRuntime(runtimeId) ? runtimeId : null;
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
