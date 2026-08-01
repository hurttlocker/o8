import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { OrchestratorBackend } from '@/lib/lane/orchestrator-backends/types';

const launchRuntimeSurface = vi.hoisted(() => vi.fn(async () => ({
  ok: true,
  surfaceId: 'claude-code:fallback-seam',
  note: 'launched',
})));

vi.mock('@/lib/runtime/actions', () => ({ launchRuntimeSurface }));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-quota-fallback-'));
writeFileSync(join(dataDir, 'worker-token'), 'quota-fallback-worker-token\n', 'utf8');
writeFileSync(join(dataDir, 'ws-token'), 'quota-fallback-ws-token\n', 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { handleCodexJsonLine } = await import('@/lib/lane/codex-orchestrator-events');
const { createLane, getLane, getLaneEvents } = await import('@/lib/lane/registry');
const { runReviewerTurnWithQuotaFallback } = await import('@/lib/lane/review-quota-fallback');
const {
  buildCrossHouseFallbackMessage,
  resolveCrossHouseFallbackForQuota,
} = await import('@/lib/orchestrator/cross-house-policy');
const { handleWorkerRuntimeFailure } = await import('@/lib/dispatch/worker-quota-fallback');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { listInboxItems } = await import('@/lib/supervisor/inbox');

function fakeBackend(
  id: 'codex' | 'claude',
  sendTurn: OrchestratorBackend['sendTurn'],
): OrchestratorBackend {
  return {
    id,
    label: id === 'codex' ? 'Codex' : 'Claude',
    peekSession: () => ({ sessionName: `test-${id}`, status: 'ready' }),
    ensureSession: () => ({ sessionName: `test-${id}`, status: 'ready' }),
    sendTurn,
  };
}

describe('cross-house quota fallback real paths', () => {
  it('routes a real Codex CLI quota frame through the ws-server policy seam', () => {
    const events: Array<{ type: string; error?: string }> = [];
    handleCodexJsonLine(JSON.stringify({
      type: 'turn.failed',
      error: {
        code: 'usage_limit_reached',
        message: 'You have hit your usage limit. Try again when it resets.',
      },
    }), { threadId: null, cost: null }, (event) => events.push(event), { isLocalModel: false });

    const error = events.find((event) => event.type === 'error')?.error;
    const fallback = resolveCrossHouseFallbackForQuota(error, {
      role: 'orchestrator',
      backend: 'codex',
      model: 'gpt-5.6-sol',
      subscriptionProfile: 'both',
    });

    expect(fallback).toMatchObject({
      action: 'handoff',
      fromHouse: 'openai',
      toHouse: 'anthropic',
      toBackend: 'claude',
      modelTier: 'frontierOrchestrator',
    });
    expect(buildCrossHouseFallbackMessage(fallback!)).toContain('Anthropic');
  });

  it('reruns the full auto-review turn and persists its visible fallback event', async () => {
    const lane = createLane({
      repoPath: '/tmp/o8-review-quota-seam',
      branch: 'inline/review-quota-seam',
      runtime: 'codex',
      packetId: `pkt-review-quota-${Date.now()}`,
    });
    const codex = fakeBackend('codex', vi.fn(async (_repo, _prompt, onEvent) => {
      onEvent({ type: 'text', text: 'partial review that must be discarded' });
      onEvent({ type: 'error', error: 'usage_limit_reached: limit resets tomorrow' });
    }));
    const claude = fakeBackend('claude', vi.fn(async (_repo, prompt, onEvent, options) => {
      expect(prompt).toBe('Review the complete packet.');
      expect(options?.model).toBeTruthy();
      onEvent({ type: 'text', text: 'complete cross-house review' });
      onEvent({ type: 'done', cost: null });
    }));

    const result = await runReviewerTurnWithQuotaFallback({
      laneId: lane.id,
      repoPath: lane.repoPath,
      threadId: `auto-review-${lane.id}`,
      surface: 'auto-review',
      prompt: 'Review the complete packet.',
      initialBackend: codex,
      backendResolver: () => claude,
    });

    expect(result).toMatchObject({
      ok: true,
      backend: 'claude',
      text: 'complete cross-house review',
    });
    expect(result.text).not.toContain('partial review');
    expect(getLaneEvents(lane.id).find((event) => event.verb === 'review_fallback')).toMatchObject({
      payload: {
        surface: 'auto-review',
        status: 'retrying',
        fromHouse: 'openai',
        toHouse: 'anthropic',
      },
    });
  });

  it('turns a runtime-adapter quota exit into a lane event and supervisor card', async () => {
    const packetId = `pkt-worker-quota-${Date.now()}`;
    const lane = createLane({
      repoPath: '/tmp/o8-worker-quota-seam',
      worktreePath: '/tmp/o8-worker-quota-seam',
      branch: 'inline/worker-quota-seam',
      runtime: 'codex',
      packetId,
    });

    const result = await handleWorkerRuntimeFailure({
      laneId: lane.id,
      runtime: 'codex',
      model: 'gpt-5.6-terra',
      surfaceId: 'codex:quota-seam',
      prompt: 'Finish the packet.',
      rawFailure: JSON.stringify({ type: 'turn.failed', error: { code: 'usage_limit_reached' } }),
    });

    expect(result).toMatchObject({ handled: true, action: 'card', toRuntime: 'claude-code' });
    expect(getLaneEvents(lane.id).find((event) => event.verb === 'worker_quota_exhausted')).toMatchObject({
      payload: {
        surfaceId: 'codex:quota-seam',
        fromRuntime: 'codex',
        suggestedRuntime: 'claude-code',
      },
    });
    expect(listInboxItems({ includeAllProjects: true }).find((item) => item.packetId === packetId)).toMatchObject({
      kind: 'worker_quota_exhausted',
      status: 'human_required',
      payload: {
        autoFallbackEnabled: false,
        suggestedRuntime: 'claude-code',
      },
    });
  });

  it('redispatches on the equal-tier runtime when the operator default is enabled', async () => {
    const packetId = `pkt-worker-auto-quota-${Date.now()}`;
    const lane = createLane({
      repoPath: '/tmp/o8-worker-auto-quota-seam',
      worktreePath: '/tmp/o8-worker-auto-quota-seam',
      branch: 'inline/worker-auto-quota-seam',
      runtime: 'codex',
      packetId,
    });
    launchRuntimeSurface.mockClear();
    await updateOperatorDefaults({ crossHouseWorkerFallback: true, subscriptionProfile: 'both' });

    try {
      const result = await handleWorkerRuntimeFailure({
        laneId: lane.id,
        runtime: 'codex',
        model: 'gpt-5.6-terra',
        surfaceId: 'codex:auto-quota-seam',
        prompt: 'Finish the packet automatically.',
        rawFailure: 'usage_limit_reached: retry tomorrow',
      });

      expect(result).toMatchObject({
        handled: true,
        action: 'redispatched',
        toRuntime: 'claude-code',
        sessionKey: 'claude-code:fallback-seam',
      });
      expect(launchRuntimeSurface).toHaveBeenCalledWith(expect.objectContaining({
        runtime: 'claude-code',
        model: expect.stringContaining('sonnet'),
        existingLaneId: lane.id,
      }));
      expect(getLane(lane.id)).toMatchObject({
        runtime: 'claude-code',
        sessionKey: 'claude-code:fallback-seam',
        status: 'running',
      });
      expect(getLaneEvents(lane.id).find((event) => event.verb === 'worker_fallback')).toBeTruthy();
    } finally {
      await updateOperatorDefaults({ crossHouseWorkerFallback: false });
    }
  });
});
