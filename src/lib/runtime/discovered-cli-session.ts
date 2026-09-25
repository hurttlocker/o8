/** External CLI identities do not imply an input-ready continuation channel. */
export function isDiscoveredCliSessionKey(runtime: string, sessionKey: string | null | undefined): boolean {
  if (!sessionKey) return false;
  if (runtime === 'codex') {
    return sessionKey.startsWith('codex:')
      || sessionKey.startsWith('codex-discovered:')
      || sessionKey.startsWith('codex-live:');
  }
  return runtime === 'claude-code'
    && (sessionKey.startsWith('claude-code:') || sessionKey.startsWith('claude-code-discovered:'));
}
