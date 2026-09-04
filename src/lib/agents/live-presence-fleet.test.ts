import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import type { RuntimeSession } from '@/lib/runtimes/types';
import { reconcileAllLiveAgentPresence } from './live-presence';
import { listAgentPresenceAcrossRepos } from './store';

function liveSession(runtimeId: 'claude-code' | 'codex', sessionKey: string): RuntimeSession {
  return {
    runtimeId,
    sessionKey,
    displayName: 'Live runtime session',
    cwd: '/workspace/o8-worktree',
    status: 'running',
    ownership: 'discovered',
    sessionCapabilities: {
      canSendInput: true,
      canInterrupt: true,
      canReviewDiffs: true,
    },
    lastActivityAt: new Date('2026-09-04T12:00:00.000Z'),
  };
}

describe('fleet live-agent presence', () => {
  it('discovers runtimes once and resolves each shared worktree once', async () => {
    const sqlite = new Database(':memory:');
    const discoverSessions = vi.fn(async () => [
      liveSession('codex', 'codex:one'),
      liveSession('claude-code', 'claude-code:two'),
    ]);
    const resolveRepoPath = vi.fn(async () => '/workspace/o8');
    const now = () => new Date('2026-09-04T12:00:00.000Z');

    const reconciled = await reconcileAllLiveAgentPresence({
      discoverSessions,
      resolveRepoPath,
      now,
    }, sqlite);

    expect(discoverSessions).toHaveBeenCalledTimes(1);
    expect(resolveRepoPath).toHaveBeenCalledTimes(1);
    expect(reconciled).toHaveLength(2);
    expect(listAgentPresenceAcrossRepos({ now: now() }, sqlite)).toEqual(expect.arrayContaining([
      expect.objectContaining({ runtime: 'codex', repo: '/workspace/o8' }),
      expect.objectContaining({ runtime: 'claude-code', repo: '/workspace/o8' }),
    ]));
    sqlite.close();
  });
});
