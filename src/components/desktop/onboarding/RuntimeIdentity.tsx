'use client';

import { ClaudeIcon, CodexIcon, GeminiIcon, OpenCodeIcon } from '../repo-registry/shared';

/** Provider identity belongs in setup choices; dense history remains text-first. */
export function RuntimeIdentity({ runtime }: { runtime: string }) {
  const icon = runtime === 'codex' ? <CodexIcon size={32} />
    : runtime === 'claude-code' ? <ClaudeIcon size={24} />
    : runtime === 'gemini' || runtime === 'antigravity' ? <GeminiIcon size={24} />
    : runtime === 'opencode' ? <OpenCodeIcon size={24} />
    : <span style={{ fontSize: 11, color: 'var(--t-text-secondary)' }}>{runtime.slice(0, 2).toUpperCase()}</span>;
  return <span aria-hidden="true" style={{ width: 32, height: 32, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, overflow: 'hidden', background: runtime === 'claude-code' ? '#fff' : 'var(--t-input-bg)' }}>{icon}</span>;
}
