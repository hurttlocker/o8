import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  update: vi.fn(async () => { throw new Error('board write failed after launch'); }),
  launch: vi.fn(async () => ({
    ok: true,
    runtime: 'codex' as const,
    clientMutationId: 'board-start-once',
    surfaceId: 'codex-owned:board-start-once',
    note: 'Provider launched.',
    cwd: '/repo',
    repoPath: '/repo',
    worktree: null,
    laneId: 'lane-board-start',
  })),
}));

vi.mock('@/lib/board/state', () => ({
  loadBoardState: vi.fn(async () => ({
    repoPath: '/repo',
    columns: [{ id: 'backlog', taskIds: ['task-1'] }, { id: 'in_progress', taskIds: [] }],
    tasks: {
      'task-1': {
        title: 'Start once',
        prompt: 'Run the task.',
        preferredRuntime: 'codex',
        baseBranch: 'main',
        automation: { startInPlanMode: false },
        bindings: {
          runtime: null,
          runtimeSurfaceId: null,
          sessionId: null,
          worktreeId: null,
          worktreePath: null,
        },
      },
    },
  })),
  getStartableTaskIds: vi.fn(() => ['task-1']),
  getBoardSnapshot: vi.fn(async () => ({ repoPath: '/repo' })),
  updateBoardState: h.update,
}));
vi.mock('@/lib/runtime/actions', () => ({ launchRuntimeSurface: h.launch }));
vi.mock('@/lib/runtimes/shared/owned-session-index', () => ({ findOwnedLaunchByMutationId: vi.fn(async () => null) }));
vi.mock('@/lib/lane/registry', () => ({ listLanes: vi.fn(() => []) }));
vi.mock('@/lib/orchestrator/idempotency-store', () => ({
  bindIdempotencyClientMutation: vi.fn(() => ({ status: 'bound' })),
  deriveIdempotencyKey: vi.fn(() => 'board-start-key'),
  withIdempotency: vi.fn(async (_params: unknown, run: () => Promise<unknown>) => ({
    replayed: false,
    inProgress: false,
    result: await run(),
  })),
}));

const route = await import('./route');

describe('board task start route', () => {
  beforeEach(() => {
    h.update.mockClear();
    h.launch.mockClear();
  });

  it('keeps a post-launch board-binding failure terminal and outcome-unknown', async () => {
    const response = await route.POST(new NextRequest('http://localhost/api/board/tasks/task-1/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: '/repo', clientMutationId: 'board-start-once' }),
    }), { params: Promise.resolve({ taskId: 'task-1' }) });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      outcomeUnknown: true,
      error: expect.stringContaining('Inspect the board task'),
    });
    expect(h.launch).toHaveBeenCalledTimes(1);
  });
});
