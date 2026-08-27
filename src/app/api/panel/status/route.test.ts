import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/codebase-memory/indexer', () => ({ ensureCodebaseMemoryBootIndex: vi.fn() }));
vi.mock('@/lib/cortex/decay', () => ({ ensureDecayBootHook: vi.fn() }));
vi.mock('@/lib/cortex/proposer', () => ({ ensureProposerBootTick: vi.fn() }));
vi.mock('@/lib/cortex/stack-signature', () => ({ ensureStackSignatureBoot: vi.fn() }));
vi.mock('@/lib/cortex/cross-repo-proposer', () => ({ ensureCrossRepoProposerBootTick: vi.fn() }));
vi.mock('@/lib/cortex/external-merge-watcher', () => ({ ensureExternalMergeBootHook: vi.fn() }));
vi.mock('@/lib/terminal/tmux', () => ({ persistentTerminalsEnabled: () => true }));
vi.mock('@/lib/terminal/persistence-health', () => ({
  currentPersistentTerminalHealth: () => ({
    schema: 'o8/persistent-terminal-health/v1',
    status: 'degraded',
    reason: 'tmux_unavailable',
    checkedAt: '2026-08-27T12:00:00.000Z',
  }),
}));

const { GET } = await import('./route');

describe('GET /api/panel/status', () => {
  it('identifies the unauthenticated liveness responder as o8', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      product: 'o8',
      mode: 'local-cli',
      terminalPersistence: {
        status: 'degraded',
        reason: 'tmux_unavailable',
      },
    });
  });
});
