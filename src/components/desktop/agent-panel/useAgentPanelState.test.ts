import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDetail } from './types';
import {
  createWarmingInventoryScheduler,
  startAgentPanelInventoryFetch,
} from './useAgentPanelState';

const liveAgent: AgentDetail = {
  id: 'agent-live',
  name: 'Live agent',
  squadId: 'squad-codex',
  model: 'codex',
  status: 'running',
  currentTask: 'Testing inventory paint',
  workspace: '/tmp/o8',
  sessionKey: 'codex-owned:live-agent',
  lastEventAt: '2026-09-05T07:00:00.000Z',
  surfaceLabel: 'Codex',
  isCurrentSession: true,
  alerts: 0,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Agent Panel inventory orchestration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('uses warming metadata for one completion-aligned fresh refetch, then stops', async () => {
    const inventoryUrls: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      if (url === '/api/panel/workspaces') return jsonResponse({ workspaces: [] });
      if (url === '/api/panel/repos') return jsonResponse({ repos: [] });
      inventoryUrls.push(url);
      return url.includes('fresh=1')
        ? jsonResponse({
            agents: [liveAgent],
            meta: { mode: 'live', gatewayFreshness: 'fresh', gatewayReachable: true },
          })
        : jsonResponse({
            agents: [],
            meta: {
              mode: 'stale',
              gatewayFreshness: 'warming',
              observablePending: true,
              warmingRetryAfterMs: 5_000,
            },
          });
    });
    const committed: AgentDetail[][] = [];
    let retryDone = Promise.resolve();
    const scheduler = createWarmingInventoryScheduler((options) => {
      retryDone = startAgentPanelInventoryFetch(fetcher, options, (inventory) => {
        committed.push(inventory.agents);
        scheduler.update(inventory.meta, options.allowWarmingRetry !== false);
      }).then(() => undefined);
    });

    const warming = await startAgentPanelInventoryFetch(fetcher, {}, (inventory) => {
      committed.push(inventory.agents);
      scheduler.update(inventory.meta);
    });
    expect(warming?.meta).toMatchObject({
      gatewayFreshness: 'warming',
      warmingRetryAfterMs: 5_000,
    });
    expect(inventoryUrls).toEqual(['/api/runtime/inventory']);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(inventoryUrls).toEqual(['/api/runtime/inventory']);

    await vi.advanceTimersByTimeAsync(1);
    await retryDone;
    expect(inventoryUrls).toEqual([
      '/api/runtime/inventory',
      '/api/runtime/inventory?fresh=1',
    ]);
    expect(committed.at(-1)).toEqual([liveAgent]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(inventoryUrls).toHaveLength(2);
    scheduler.dispose();
  });

  it('commits inventory rows while workspace and repository enrichment remain unresolved', async () => {
    const never = new Promise<Response>(() => {});
    const fetcher = vi.fn(async (url: string) => {
      if (url === '/api/runtime/inventory') {
        return jsonResponse({
          agents: [liveAgent],
          meta: { mode: 'live', gatewayFreshness: 'fresh', gatewayReachable: true },
        });
      }
      return never;
    });
    const commit = vi.fn();

    const inventory = await startAgentPanelInventoryFetch(fetcher, {}, commit);

    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ agents: [liveAgent] }));
    expect(inventory?.agents).toEqual([liveAgent]);
  });

  it('preserves committed inventory rows when workspace and repository enrichment fail', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url === '/api/runtime/inventory') {
        return jsonResponse({
          agents: [liveAgent],
          meta: { mode: 'live', gatewayFreshness: 'fresh', gatewayReachable: true },
        });
      }
      throw new Error('enrichment unavailable');
    });
    const commit = vi.fn();

    const inventory = await startAgentPanelInventoryFetch(fetcher, {}, commit);
    await expect(inventory?.enrichment).resolves.toEqual([null, null]);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ agents: [liveAgent] }));
  });
});
