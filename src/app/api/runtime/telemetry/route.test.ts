import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const testRoot = mkdtempSync(join(tmpdir(), 'o8-thread-telemetry-'));
const dataDir = join(testRoot, 'data');
const historyDir = join(dataDir, 'chat-history');
process.env.CORTEX_IDE_DATA_DIR = dataDir;
mkdirSync(historyDir, { recursive: true });

const mocks = vi.hoisted(() => ({
  getTelemetry: vi.fn(async (sessionKey: string) => ({
    totalTokens: sessionKey.includes('claude-code:') ? 80_000 : 4_000,
    contextTokens: sessionKey.includes('claude-code:') ? 75_000 : 3_500,
  })),
}));

vi.mock('@/lib/runtimes/registry', () => ({
  registerRuntime: vi.fn(),
  getRuntime: vi.fn(() => ({
    capabilities: { costTelemetry: true },
    getTelemetry: mocks.getTelemetry,
  })),
}));

const { GET } = await import('./route');

function request(params: Record<string, string>) {
  return new NextRequest(`http://localhost/api/runtime/telemetry?${new URLSearchParams(params)}`);
}

function persistThread(threadId: string, sessionIds: Record<string, string>) {
  writeFileSync(join(historyDir, `${threadId}.json`), JSON.stringify({
    repoPath: '/repo',
    messages: [{ id: 'm1', role: 'user', content: 'hello' }],
    orchestratorSessionIds: sessionIds,
  }));
}

beforeEach(() => {
  mocks.getTelemetry.mockClear();
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe('thread-bound runtime telemetry', () => {
  it('resolves the provider session persisted on the requested UI thread', async () => {
    persistThread('thoughts-a', { claude: 'claude-a', codex: 'codex-a' });
    persistThread('thoughts-b', { claude: 'claude-b' });

    const response = await GET(request({ threadId: 'thoughts-a', backend: 'claude' }));

    expect(response.status).toBe(200);
    expect(mocks.getTelemetry).toHaveBeenCalledWith('claude-code:claude-a');
    expect(mocks.getTelemetry).not.toHaveBeenCalledWith('claude-code:claude-b');
  });

  it('switches providers using only the session id bound to that provider', async () => {
    persistThread('thoughts-switch', { claude: 'claude-old', codex: 'codex-new' });

    const claudeResponse = await GET(request({ threadId: 'thoughts-switch', backend: 'claude' }));
    const codexResponse = await GET(request({ threadId: 'thoughts-switch', backend: 'codex' }));

    expect(claudeResponse.status).toBe(200);
    expect(codexResponse.status).toBe(200);
    expect(mocks.getTelemetry.mock.calls.map(([sessionKey]) => sessionKey)).toEqual([
      'claude-code:claude-old',
      'codex:codex-new',
    ]);
  });

  it('fails closed when a fresh thread has no persisted provider binding', async () => {
    persistThread('thoughts-fresh', {});

    const response = await GET(request({ threadId: 'thoughts-fresh', backend: 'claude' }));

    expect(response.status).toBe(404);
    expect(mocks.getTelemetry).not.toHaveBeenCalled();
  });
});
