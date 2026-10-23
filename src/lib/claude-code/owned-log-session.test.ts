import { describe, expect, it } from 'vitest';
import { parseClaudeOwnedRunLog } from './owned-log';
import type { OwnedRunRecord } from '@/lib/runtimes/shared/owned-session/types';

describe('owned Claude provider identity while a packet is running', () => {
  it('persists the init session before the terminal result arrives', () => {
    const run = { id: 'running', outcome: 'running', startedAt: '2026-10-23T00:00:00Z' } as OwnedRunRecord;
    const parsed = parseClaudeOwnedRunLog(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-in-progress' })}\n`, run);
    expect(parsed.threadId).toBe('session-in-progress');
    expect(parsed.outcome).toBe('running');
    expect(parsed.completedTurn).toBe(false);
  });
});
