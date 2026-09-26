import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { launchRuntimeSurface } = vi.hoisted(() => ({
  launchRuntimeSurface: vi.fn(async (input: Record<string, unknown>) => ({
    ok: true,
    surfaceId: `codex-owned:${input.clientMutationId}`,
    note: 'launched',
  })),
}));
vi.mock('@/lib/runtime/actions', () => ({ launchRuntimeSurface }));
vi.mock('@/lib/runtimes/shared/owned-session-index', () => ({ findOwnedLaunchByMutationId: vi.fn(async () => null) }));
vi.mock('@/lib/panel/api-port', () => ({ resolvePortInfo: () => ({ wsPort: 12345 }) }));
vi.mock('@/lib/ws-auth', () => ({ getOrCreateWsToken: () => 'test-token' }));

import { launchSharedCheckoutWorker } from './shared-checkout-launch';
import { readSharedCheckoutTeam } from './shared-checkout-team';

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'o8-shared-launch-'));
  roots.push(root);
  const repoPath = join(root, 'repo');
  mkdirSync(repoPath);
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath });
  writeFileSync(join(repoPath, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
  execFileSync('git', ['-c', 'user.name=o8 test', '-c', 'user.email=test@o8.local', 'commit', '-m', 'fixture'], { cwd: repoPath });
  return repoPath;
}

afterEach(() => {
  vi.unstubAllGlobals();
  launchRuntimeSurface.mockClear();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Fast worker launch', () => {
  it('launches two runtime surfaces into one checkout and binds both to the parent chat', async () => {
    const repoPath = fixture();
    const parentThreadId = 'thoughts-fast-team';
    const watched: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      watched.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return { ok: true };
    }));
    const common = { repoPath, parentThreadId, runtime: 'codex' as const, model: null, readOnly: false, repoInProject: true };
    const [a, b] = await Promise.all([
      launchSharedCheckoutWorker({ ...common, prompt: 'Edit A', taskName: 'A', clientMutationId: 'a', assignedPaths: ['src/a'] }),
      launchSharedCheckoutWorker({ ...common, prompt: 'Edit B', taskName: 'B', clientMutationId: 'b', assignedPaths: ['src/b'] }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(launchRuntimeSurface).toHaveBeenCalledTimes(2);
    expect(launchRuntimeSurface.mock.calls[0][0]).toMatchObject({ repoPath: expect.any(String), isolate: false, skipSetup: true });
    expect(launchRuntimeSurface.mock.calls[0][0].repoPath).toBe(launchRuntimeSurface.mock.calls[1][0].repoPath);
    expect(watched).toHaveLength(2);
    expect(watched.every((receipt) => (
      (receipt.launchContext as { parentThreadId?: string })?.parentThreadId === parentThreadId
    ))).toBe(true);
    expect(readSharedCheckoutTeam({ repoPath, parentThreadId })?.members.map((member) => member.state)).toEqual(['running', 'running']);
  });

  it('retains a created surface when launch reports failure so review cannot miss it', async () => {
    const repoPath = fixture();
    const parentThreadId = 'thoughts-fast-team';
    launchRuntimeSurface.mockImplementationOnce(async () => ({
      ok: false,
      surfaceId: 'codex-owned:failed',
      note: 'Provider created a session but registration failed.',
    }));
    const result = await launchSharedCheckoutWorker({
      repoPath, parentThreadId, runtime: 'codex', model: null, readOnly: false,
      repoInProject: true, prompt: 'Edit A', taskName: 'A', clientMutationId: 'failed', assignedPaths: ['src/a'],
    });
    expect(result).toMatchObject({ ok: false, surfaceId: 'codex-owned:failed' });
    expect(readSharedCheckoutTeam({ repoPath, parentThreadId })?.members[0]).toMatchObject({
      surfaceId: 'codex-owned:failed', state: 'failed',
    });
    await expect(launchSharedCheckoutWorker({
      repoPath, parentThreadId, runtime: 'codex', model: null, readOnly: false,
      repoInProject: true, prompt: 'Edit A again', taskName: 'B', clientMutationId: 'overlap', assignedPaths: ['src/a/file.ts'],
    })).rejects.toThrow(/overlaps worker A/);
  });
});
