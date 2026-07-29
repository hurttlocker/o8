import { homedir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  autoCompact: vi.fn(async () => ({
    applied: false,
    transcript: [],
    tokensAfter: 0,
    resumePrelude: null,
  })),
  registryResolve: vi.fn(async () => ({
    ok: false as const,
    message: 'not registered',
    status: 400,
  })),
  resetSession: vi.fn((repoPath: string, threadId?: string | null) => ({
    repoPath,
    sessionName: 'home-session',
    threadId: threadId ?? null,
  })),
}));

vi.mock('@/lib/panel/auth', () => ({
  requirePanelAuth: () => null,
}));
vi.mock('@/lib/orchestrator/auto-compact', () => ({
  autoCompactOrchestratorThread: mocks.autoCompact,
}));
vi.mock('@/lib/repos/repo-path-registry', () => ({
  resolveRepoPathFromRegistry: mocks.registryResolve,
}));
vi.mock('@/lib/lane/orchestrator-session', () => ({
  requestOrchestratorSessionReset: mocks.resetSession,
}));
vi.mock('@/lib/repos/registry', () => ({
  listRepos: vi.fn(async () => []),
}));

const compactRoute = await import('./compact/route');
const resetRoute = await import('./reset-session/route');

function post(pathname: string, body: unknown) {
  return new NextRequest(`http://localhost:3001${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('orchestrator home HTTP session seams', () => {
  it('compacts home mode against the resolved home path without registry lookup', async () => {
    const response = await compactRoute.POST(post('/api/orchestrator/compact', {
      repoPath: '~',
      messages: [],
      runningTotal: 0,
    }));

    expect(response.status).toBe(200);
    expect(mocks.registryResolve).not.toHaveBeenCalled();
    expect(mocks.autoCompact).toHaveBeenCalledWith(expect.objectContaining({
      repoPath: homedir(),
    }));
  });

  it('resets the home session using the same resolved path', async () => {
    const response = await resetRoute.POST(post('/api/orchestrator/reset-session', {
      repoPath: '~',
      threadId: 'thoughts-home-reset',
    }));

    expect(response.status).toBe(200);
    expect(mocks.resetSession).toHaveBeenCalledWith(homedir(), 'thoughts-home-reset');
  });
});
