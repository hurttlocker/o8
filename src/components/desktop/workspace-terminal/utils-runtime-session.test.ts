import { describe, expect, it } from 'vitest';

import {
  isOwnedCliRuntimeSession,
  normalizeWorkspaceChatSessionKey,
} from './utils';

describe('workspace owned runtime session routing', () => {
  it('preserves a cloud key even with a stale local runtime hint', () => {
    expect(normalizeWorkspaceChatSessionKey('codex', 'cloud:worker')).toBe('cloud:worker');
    expect(normalizeWorkspaceChatSessionKey('cloud', 'worker')).toBe('cloud:worker');
    expect(isOwnedCliRuntimeSession('cloud:worker')).toBe(false);
  });

  it.each([
    ['pi', 'pi-owned:abc'],
    ['prime-agent', 'prime-agent-owned:abc'],
    ['qwen', 'qwen-owned:abc'],
  ] as const)('keeps %s session keys attached to their runtime', (runtime, sessionKey) => {
    expect(normalizeWorkspaceChatSessionKey(runtime, sessionKey)).toBe(sessionKey);
    expect(normalizeWorkspaceChatSessionKey(runtime, 'abc')).toBe(sessionKey);
    expect(isOwnedCliRuntimeSession(sessionKey)).toBe(true);
  });
});
