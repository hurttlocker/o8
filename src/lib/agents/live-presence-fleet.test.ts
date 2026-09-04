import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import type { RuntimeSession } from '@/lib/runtimes/types';
import { reconcileAllLiveAgentPresence } from './live-presence';
import {
  ensureAgentBusSchema,
  listAgentPresenceAcrossRepos,
} from './store';

function liveSession(
  runtimeId: 'claude-code' | 'codex',
  sessionKey: string,
  cwd = '/workspace/o8-worktree',
): RuntimeSession {
  return {
    runtimeId,
    sessionKey,
    displayName: 'Live runtime session',
    cwd,
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

  it('resolves distinct session worktrees concurrently', async () => {
    const sqlite = new Database(':memory:');
    const releases: Array<(repo: string | null) => void> = [];
    const resolveRepoPath = vi.fn((_cwd: string) => new Promise<string | null>((resolve) => {
      releases.push(resolve);
    }));
    const pending = reconcileAllLiveAgentPresence({
      discoverSessions: async () => [
        liveSession('codex', 'codex:one', '/workspace/one'),
        liveSession('codex', 'codex:two', '/workspace/two'),
        liveSession('claude-code', 'claude-code:three', '/workspace/three'),
      ],
      resolveRepoPath,
      now: () => new Date('2026-09-04T12:00:00.000Z'),
    }, sqlite);

    await vi.waitFor(() => expect(resolveRepoPath).toHaveBeenCalledTimes(3));
    releases.forEach((release, index) => release(`/workspace/repo-${index}`));
    await expect(pending).resolves.toHaveLength(3);
    sqlite.close();
  });

  it('filters stale fleet rows in SQLite through the global seen index', () => {
    const sqlite = new Database(':memory:');
    ensureAgentBusSchema(sqlite);
    const insert = sqlite.prepare(`
      INSERT INTO agent_presence
        (agent_id, name, repo_path, worktree_path, runtime, session_key, lane_id, packet_id, last_seen)
      VALUES (?, ?, ?, NULL, 'codex', NULL, NULL, NULL, ?)
    `);
    sqlite.transaction(() => {
      for (let index = 0; index < 1_000; index += 1) {
        insert.run(`stale-${index}`, `Stale ${index}`, `/workspace/stale-${index}`, '2020-01-01T00:00:00.000Z');
      }
      insert.run('live-one', 'Live one', '/workspace/live', '2026-09-04T11:59:00.000Z');
      insert.run('live-two', 'Live two', '/workspace/live', '2026-09-04T11:58:00.000Z');
    })();

    expect(listAgentPresenceAcrossRepos({
      now: new Date('2026-09-04T12:00:00.000Z'),
    }, sqlite).map((agent) => agent.agentId)).toEqual(['live-one', 'live-two']);
    const plan = sqlite.prepare(`
      EXPLAIN QUERY PLAN
      SELECT * FROM agent_presence
      WHERE last_seen >= ?
      ORDER BY last_seen DESC, name ASC
    `).all('2026-09-04T11:54:00.000Z') as Array<{ detail: string }>;
    expect(plan.some((step) => step.detail.includes('idx_agent_presence_seen'))).toBe(true);
    sqlite.close();
  });
});
