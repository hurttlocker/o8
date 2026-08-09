import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  defaults: {
    subscriptionProfile: 'both',
    defaultDispatchRuntime: 'opencode',
    opencodeWorkerModel: 'openrouter/deepseek/deepseek-v4-flash' as string | null,
    defaultDispatchModel: '',
  },
  dispatch: vi.fn(async (command: { verb: string }) => command.verb === 'open_lane'
    ? { ok: true, laneId: 'lane-opencode2-test', note: 'lane opened' }
    : {
        ok: true,
        note: 'session launched',
        lane: {
          sessionKey: 'opencode-owned:opencode2-test',
          worktreePath: '/tmp/o8-opencode2-test',
        },
      }),
  state: {
    packets: [] as unknown[],
    missionId: null as string | null,
    prompt: null as string | null,
    summary: null as string | null,
    repoPath: null as string | null,
    runtime: null as string | null,
    updatedAt: null as string | null,
  },
}));

vi.mock('@/lib/lane/commands', () => ({ dispatch: mocks.dispatch }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/command-center/snapshot', () => ({ invalidateCommandCenterSnapshotCaches: vi.fn() }));
vi.mock('@/lib/mobile/inbox', () => ({ invalidateInboxCache: vi.fn() }));
vi.mock('@/lib/dispatch/edge-case-surfacer', () => ({ surfaceEdgeCases: () => ({ sites: [] }) }));
vi.mock('@/lib/dispatch/read-budget', () => ({
  computeReadBudget: () => null,
  resolveModelTier: () => 'cheap',
}));
vi.mock('@/lib/orchestrator/preservation-envelope', () => ({ computePredictedFiles: () => [] }));
vi.mock('@/lib/operator/defaults', () => ({
  getOperatorDefaultsSync: () => ({ values: mocks.defaults }),
}));
vi.mock('@/lib/projects/context', () => ({
  getProjectContext: vi.fn(async () => ({ id: 'project-opencode2-test' })),
  buildProjectTaskBrief: () => ({ title: 'OpenCode 2 routing proof' }),
}));
vi.mock('@/lib/prompts/v1', () => ({ buildProjectBriefPromptV1: (_brief: unknown, prompt: string) => prompt }));
vi.mock('@/lib/orchestrator/control-plane', () => ({
  withLockedState: async (callback: (state: typeof mocks.state) => unknown) => callback(mocks.state),
}));

const delegateRoute = await import('@/app/api/orchestrator/delegate/route');

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3001/api/orchestrator/delegate', {
    method: 'POST',
    body: JSON.stringify({
      prompt: 'Make a one-word README edit.',
      repoPath: '/tmp/o8-opencode2-test',
      taskName: 'OpenCode 2 routing proof',
      ...body,
    }),
  });
}

describe('orchestrator delegate worker routing', () => {
  it('uses the saved OpenCode runtime and DeepSeek model when the caller omits both', async () => {
    mocks.dispatch.mockClear();
    const response = await delegateRoute.POST(request({}));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.workerRouting).toMatchObject({
      selectedRuntime: 'opencode',
      selectedModel: 'openrouter/deepseek/deepseek-v4-flash',
    });
    expect(mocks.dispatch).toHaveBeenNthCalledWith(1, expect.objectContaining({
      verb: 'open_lane',
      runtime: 'opencode',
    }));
    expect(mocks.dispatch).toHaveBeenNthCalledWith(2, expect.objectContaining({
      verb: 'launch_session',
      model: 'openrouter/deepseek/deepseek-v4-flash',
    }));
  });

  it('keeps an explicitly requested runtime and model above saved defaults', async () => {
    mocks.dispatch.mockClear();
    const response = await delegateRoute.POST(request({
      runtime: 'codex',
      model: 'gpt-5.6-terra',
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.workerRouting).toMatchObject({
      selectedRuntime: 'codex',
      selectedModel: 'gpt-5.6-terra',
    });
    expect(mocks.dispatch).toHaveBeenNthCalledWith(1, expect.objectContaining({
      runtime: 'codex',
    }));
    expect(mocks.dispatch).toHaveBeenNthCalledWith(2, expect.objectContaining({
      model: 'gpt-5.6-terra',
    }));
  });

  it('uses the OpenCode 2 adapter model instead of a foreign generic default when no pin exists', async () => {
    mocks.dispatch.mockClear();
    mocks.defaults.opencodeWorkerModel = null;
    mocks.defaults.defaultDispatchModel = 'gpt-5.6-terra';

    try {
      const response = await delegateRoute.POST(request({}));
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.workerRouting).toMatchObject({
        selectedRuntime: 'opencode',
        selectedModel: 'opencode/deepseek-v4-flash-free',
      });
      expect(mocks.dispatch).toHaveBeenNthCalledWith(2, expect.objectContaining({
        model: 'opencode/deepseek-v4-flash-free',
      }));
    } finally {
      mocks.defaults.opencodeWorkerModel = 'openrouter/deepseek/deepseek-v4-flash';
      mocks.defaults.defaultDispatchModel = '';
    }
  });

  it('rejects an unsupported explicit runtime instead of silently falling back', async () => {
    mocks.dispatch.mockClear();
    const response = await delegateRoute.POST(request({ runtime: 'not-a-runtime' }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: 'Unsupported worker runtime: not-a-runtime',
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});
