import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
const ensureDispatchBackendReadyMock = vi.hoisted(() => vi.fn(async () => ({
  ready: true,
  reason: 'http_200',
  waitedMs: 0,
  attempts: 1,
})));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

vi.mock('@/lib/runtimes/shared/dispatch-readiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/dispatch-readiness')>();
  return {
    ...actual,
    ensureDispatchBackendReady: ensureDispatchBackendReadyMock,
  };
});

vi.mock('@/lib/runtimes/shared/auth-detect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/auth-detect')>();
  const readyStatus = (house: 'codex' | 'claude' | 'opencode' | 'cursor' | 'grok', runtime: string) => ({
    house,
    runtime,
    installed: true,
    authenticated: true,
    detail: `${runtime} ready`,
    fix: '',
    checkedAt: Date.now(),
  });
  return {
    ...actual,
    getRuntimeAuthSnapshot: vi.fn(async () => ({
      statuses: {
        codex: readyStatus('codex', 'codex'),
        claude: readyStatus('claude', 'claude-code'),
        opencode: readyStatus('opencode', 'opencode'),
        cursor: readyStatus('cursor', 'cursor'),
        grok: readyStatus('grok', 'grok'),
      },
      suggestedSubscriptionProfile: { profile: null, detail: null },
    })),
    assertRuntimeDispatchable: vi.fn(async () => undefined),
  };
});

vi.mock('@/lib/usage-log', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/usage-log')>();
  return {
    ...actual,
    monitorUsageDispatch: vi.fn(),
  };
});

vi.mock('@/lib/analytics/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/analytics/server')>();
  return {
    ...actual,
    emitProductEvent: vi.fn(async () => undefined),
  };
});

const testRoot = mkdtempSync(path.join(os.homedir(), '.o8-operator-mcp-routing-'));
const priorEnv: Record<string, string | undefined> = {};
const controlledEnvKeys = [
  'CORTEX_IDE_DATA_DIR',
  'O8_DATA_DIR',
  'CORTEX_IDE_OWNED_CODEX_ROOT',
  'O8_CODEX_BIN',
  'O8_CRASH_SURVIVABLE_WORKERS',
  'O8_SKIP_PRELAUNCH_TYPECHECK',
  'O8_DISPATCH_MODEL',
  'O8_SUBSCRIPTION_PROFILE',
] as const;

function resultJson(result: { content: Array<{ type: 'text'; text: string } | { type: 'image' }> }) {
  const text = result.content.find((entry) => entry.type === 'text')?.text ?? '';
  return JSON.parse(text) as Record<string, unknown>;
}

function createTempRepo() {
  const repoPath = mkdtempSync(path.join(testRoot, 'repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
  git('init', '--initial-branch=main');
  writeFileSync(path.join(repoPath, 'README.md'), 'operator defaults routing test\n');
  git('add', 'README.md');
  git('-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test', 'commit', '-m', 'init');
  return repoPath;
}

function stubOperatorDefaultsApi() {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    if (url.includes('/api/panel/operator-defaults')) {
      const route = await import('@/app/api/panel/operator-defaults/route');
      if ((init?.method ?? 'GET') === 'POST') {
        return route.POST(new Request(url, {
          method: 'POST',
          headers: init?.headers,
          body: init?.body,
        }));
      }
      return route.GET();
    }
    if (url.includes('/supervisor/watch') || url.includes('/internal/realtime')) {
      return Response.json({ ok: true });
    }
    throw new Error(`Unhandled test fetch: ${url}`);
  }));
}

beforeAll(() => {
  for (const key of controlledEnvKeys) priorEnv[key] = process.env[key];
  process.env.CORTEX_IDE_DATA_DIR = testRoot;
  process.env.O8_DATA_DIR = testRoot;
  process.env.CORTEX_IDE_OWNED_CODEX_ROOT = path.join(testRoot, 'owned-codex');
  process.env.O8_CODEX_BIN = process.execPath;
  process.env.O8_CRASH_SURVIVABLE_WORKERS = '1';
  process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
  delete process.env.O8_DISPATCH_MODEL;
  delete process.env.O8_SUBSCRIPTION_PROFILE;
});

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockReturnValue({
    pid: 987_654,
    stdin: { end: vi.fn() },
    unref: vi.fn(),
    once: vi.fn(),
  });
  ensureDispatchBackendReadyMock.mockClear();
  stubOperatorDefaultsApi();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const key of controlledEnvKeys) {
    const prior = priorEnv[key];
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
  rmSync(testRoot, { recursive: true, force: true });
});

describe('MCP operator defaults and dispatch routing', () => {
  it('sets worker effort and merge approval posture through the registered MCP schema and real handler', async () => {
    const { STATUS_TOOLS, handleOperatorDefaults } = await import('@/lib/mcp/operator-handlers/status');
    const tool = STATUS_TOOLS.find((candidate) => candidate.name === 'o8_operator_defaults');
    const properties = tool?.inputSchema.properties as Record<string, unknown> | undefined;

    expect(properties).toMatchObject({
      codexWorkerEffort: expect.any(Object),
      claudeWorkerEffort: expect.any(Object),
      defaultDispatchModel: expect.any(Object),
      workersUseBrain: expect.any(Object),
      requireApproval: expect.objectContaining({
        enum: ['high-risk', 'always', 'never'],
      }),
    });

    const result = await handleOperatorDefaults({ codexWorkerEffort: 'xhigh', requireApproval: 'always' });
    expect(result.isError).not.toBe(true);
    expect(resultJson(result).values).toMatchObject({ codexWorkerEffort: 'xhigh', requireApproval: 'always' });

    const { getOperatorDefaults } = await import('@/lib/operator/defaults');
    expect((await getOperatorDefaults()).values).toMatchObject({
      codexWorkerEffort: 'xhigh',
      requireApproval: 'always',
    });
  });

  it('rejects unknown MCP keys as a structured error without applying a partial update', async () => {
    const { getOperatorDefaults } = await import('@/lib/operator/defaults');
    const before = (await getOperatorDefaults()).values.codexWorkerEffort;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockClear();

    const { handleOperatorDefaults } = await import('@/lib/mcp/operator-handlers/status');
    const result = await handleOperatorDefaults({
      codexWorkerEffort: 'low',
      codexWorkerEfort: 'xhigh',
    });
    const payload = resultJson(result);

    expect(result.isError).toBe(true);
    expect(payload).toMatchObject({
      ok: false,
      error: {
        code: 'unknown_operator_default_keys',
        unknownKeys: ['codexWorkerEfort'],
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await getOperatorDefaults()).values.codexWorkerEffort).toBe(before);
  });

  it('carries defaultDispatchModel through mission creation into the Codex spawn argv', async () => {
    const { handleOperatorDefaults } = await import('@/lib/mcp/operator-handlers/status');
    const defaultsResult = await handleOperatorDefaults({
      defaultDispatchRuntime: 'codex',
      defaultDispatchModel: 'gpt-5.6-sol',
    });
    expect(defaultsResult.isError).not.toBe(true);

    const repoPath = createTempRepo();
    const { NextRequest } = await import('next/server');
    const { POST } = await import('@/app/api/orchestrator/create-mission/route');
    const response = await POST(new NextRequest('http://127.0.0.1:47120/api/orchestrator/create-mission', {
      method: 'POST',
      headers: { host: 'localhost:47120', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoPath,
        requestedRuntime: 'codex',
        issues: [{ number: 1, title: 'Honor the configured worker model', body: '', url: '' }],
      }),
    }));
    const created = await response.json() as { ok: boolean; result: { missionId: string } };
    expect(created.ok).toBe(true);

    const { dispatchMission } = await import('@/lib/orchestrator/operator-mission-service/mission');
    const dispatched = await dispatchMission({ missionId: created.result.missionId });
    expect(dispatched.dispatched).toBe(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const [command, args] = spawnMock.mock.calls[0]!;
    expect(command).toBe(process.platform === 'win32' ? process.execPath : 'nice');
    const argv = process.platform === 'win32' ? args : args.slice(2);
    const modelIndex = argv.indexOf('--model');
    expect(modelIndex).toBeGreaterThan(-1);
    expect(argv[modelIndex + 1]).toBe('gpt-5.6-sol');
    expect(argv).not.toContain('gpt-5.6-terra');
  }, 30_000);
});
