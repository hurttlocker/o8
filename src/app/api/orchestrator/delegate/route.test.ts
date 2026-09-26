import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { launchRuntimeSurface } = vi.hoisted(() => ({
  launchRuntimeSurface: vi.fn(async (input: Record<string, unknown>) => ({
    ok: true,
    surfaceId: `codex-owned:${input.clientMutationId}`,
    note: 'launched',
  })),
}));
vi.mock('@/lib/runtime/actions', () => ({ launchRuntimeSurface }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/panel/api-port', () => ({ resolvePortInfo: () => ({ wsPort: 12345 }) }));
vi.mock('@/lib/ws-auth', () => ({ getOrCreateWsToken: () => 'test-token' }));

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'o8-fast-route-'));
  roots.push(root);
  const repoPath = join(root, 'repo');
  mkdirSync(repoPath);
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath });
  writeFileSync(join(repoPath, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
  execFileSync('git', ['-c', 'user.name=o8 test', '-c', 'user.email=test@o8.local', 'commit', '-m', 'fixture'], { cwd: repoPath });
  const state = join(root, 'state');
  mkdirSync(join(state, 'chat-history'), { recursive: true });
  writeFileSync(join(state, 'chat-history', 'thoughts-fast-route.json'), JSON.stringify({
    repoPath,
    messages: [
      { id: 'user-1', role: 'user', content: 'Run these tasks' },
      { id: 'assistant-1', role: 'assistant', content: '', receipt: { pickedMode: 'fast' } },
    ],
  }));
  return { root, repoPath, state };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  launchRuntimeSurface.mockClear();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('orchestrator Fast delegation entry', () => {
  it('binds two API launches to one persisted team and their parent chat without worktrees', async () => {
    const { repoPath, state } = fixture();
    vi.stubEnv('O8_DATA_DIR', state);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    const { fastDelegationCapability } = await import('@/lib/orchestrator/fast-delegation-auth');
    const fastCapability = fastDelegationCapability(repoPath, 'thoughts-fast-route');
    const { POST } = await import('./route');
    const dispatch = async (id: string, path: string) => {
      const request = new NextRequest('http://localhost/api/orchestrator/delegate', {
        method: 'POST',
        body: JSON.stringify({
          prompt: `Inspect ${path}`,
          repoPath,
          taskName: path,
          runtime: 'codex',
          checkoutMode: 'shared',
          parentThreadId: 'thoughts-fast-route',
          fastCapability,
          assignedPaths: [path],
          readOnly: true,
          clientMutationId: id,
        }),
      });
      return POST(request);
    };
    const [first, second] = await Promise.all([dispatch('a', 'src/a'), dispatch('b', 'src/b')]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await first.json()).launchContext).toMatchObject({ parentThreadId: 'thoughts-fast-route', checkoutMode: 'shared' });
    expect(launchRuntimeSurface).toHaveBeenCalledTimes(2);
    expect(launchRuntimeSurface.mock.calls.every(([input]) => input.isolate === false && input.skipSetup === true)).toBe(true);
    const teamFiles = (await import('node:fs')).readdirSync(join(state, 'shared-checkout-teams')).filter((file) => file.endsWith('.json'));
    expect(teamFiles).toHaveLength(1);
    const team = JSON.parse(readFileSync(join(state, 'shared-checkout-teams', teamFiles[0]!), 'utf8')) as { members: Array<{ surfaceId: string }> };
    expect(team.members.map((member) => member.surfaceId).sort()).toEqual(['codex-owned:a', 'codex-owned:b']);
    writeFileSync(join(state, 'chat-history', 'thoughts-fast-route.json'), JSON.stringify({ repoPath, messages: [
      { role: 'user', content: 'Continue in Solo' },
      { role: 'assistant', content: '', receipt: { pickedMode: 'solo' } },
    ] }));
    expect((await dispatch('a', 'src/a')).status).toBe(403);
  });

  it('rejects a bearer caller spoofing the chat, capability, or selected mode', async () => {
    const { repoPath, state } = fixture();
    vi.stubEnv('O8_DATA_DIR', state);
    const { fastDelegationCapability } = await import('@/lib/orchestrator/fast-delegation-auth');
    const { POST } = await import('./route');
    const fastCapability = fastDelegationCapability(repoPath, 'thoughts-fast-route');
    const launch = (parentThreadId: string, capability: string, id: string) => POST(new NextRequest('http://localhost/api/orchestrator/delegate', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'Inspect', repoPath, checkoutMode: 'shared', parentThreadId,
        fastCapability: capability, clientMutationId: id }),
    }));
    expect((await launch('thoughts-fast-route', '', 'missing-proof')).status).toBe(403);
    expect((await launch('thoughts-spoofed', fastCapability, 'spoof-parent')).status).toBe(404);
    writeFileSync(join(state, 'chat-history', 'thoughts-another-chat.json'), readFileSync(join(state, 'chat-history', 'thoughts-fast-route.json')));
    expect((await launch('thoughts-another-chat', fastCapability, 'other-parent')).status).toBe(403);
    writeFileSync(join(state, 'chat-history', 'thoughts-fast-route.json'), JSON.stringify({ repoPath, messages: [
      { role: 'user', content: 'Now work solo' },
      { role: 'assistant', content: '', receipt: { pickedMode: 'solo' } },
    ] }));
    expect((await launch('thoughts-fast-route', fastCapability, 'wrong-mode')).status).toBe(403);
    expect(launchRuntimeSurface).not.toHaveBeenCalled();
  });
});
