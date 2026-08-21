import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
const resolveDefaultWorkerEffortSyncMock = vi.hoisted(() => vi.fn((runtime, explicitEffort) => explicitEffort ?? undefined));
const ensureDispatchBackendReadyMock = vi.hoisted(() => vi.fn(async () => ({
  ready: true,
  reason: 'http_200',
  waitedMs: 0,
  attempts: 1,
})));
const ensureCodexSubscriptionProxyReadyMock = vi.hoisted(() => vi.fn(async () => ({
  baseUrl: 'http://127.0.0.1:8317',
  clientToken: 'local-codex-test-token',
  models: ['gpt-5.6-sol'],
})));
const ensureCodexSubscriptionClaudeConfigDirMock = vi.hoisted(() => vi.fn());

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

vi.mock('@/lib/operator/defaults', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/operator/defaults')>();
  return {
    ...actual,
    resolveDefaultWorkerEffortSync: resolveDefaultWorkerEffortSyncMock,
  };
});

vi.mock('@/lib/claude-code/codex-subscription-proxy', () => ({
  ensureCodexSubscriptionProxyReady: ensureCodexSubscriptionProxyReadyMock,
  ensureCodexSubscriptionClaudeConfigDir: ensureCodexSubscriptionClaudeConfigDirMock,
}));

describe('Claude Code dispatch spawn', () => {
  let tempRoot: string;
  let repoPath: string;
  let priorOwnedRoot: string | undefined;
  let priorClaudeBin: string | undefined;
  let priorOpenRouterKey: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    tempRoot = mkdtempSync(path.join(process.env.CORTEX_IDE_DATA_DIR!, 'claude-dispatch-'));
    repoPath = path.join(tempRoot, 'repo');
    execFileSync('git', ['init', '-q', repoPath]);
    priorOwnedRoot = process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT;
    priorClaudeBin = process.env.O8_CLAUDE_CODE_BIN;
    priorOpenRouterKey = process.env.OPENROUTER_API_KEY;
    process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT = path.join(tempRoot, 'owned');
    process.env.O8_CLAUDE_CODE_BIN = process.execPath;
    delete process.env.OPENROUTER_API_KEY;
    spawnMock.mockReturnValue({
      pid: 42,
      stdin: { end: vi.fn() },
      unref: vi.fn(),
      once: vi.fn(),
    });
    ensureDispatchBackendReadyMock.mockClear();
    ensureCodexSubscriptionProxyReadyMock.mockClear();
    ensureCodexSubscriptionClaudeConfigDirMock.mockImplementation(async (sessionDir: string) =>
      path.join(sessionDir, 'claude-code-codex-config'));
    resolveDefaultWorkerEffortSyncMock.mockImplementation((runtime, explicitEffort) => explicitEffort ?? undefined);
  });

  afterEach(() => {
    spawnMock.mockReset();
    resolveDefaultWorkerEffortSyncMock.mockReset();
    if (priorOwnedRoot === undefined) delete process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT;
    else process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT = priorOwnedRoot;
    if (priorClaudeBin === undefined) delete process.env.O8_CLAUDE_CODE_BIN;
    else process.env.O8_CLAUDE_CODE_BIN = priorClaudeBin;
    if (priorOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = priorOpenRouterKey;
    try { unlinkSync(path.join(process.env.CORTEX_IDE_DATA_DIR!, 'claude-code-worker.json')); } catch {}
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('launches a dispatched worker as stream-json without print flags in the packet worktree cwd', async () => {
    const { claudeCodeRuntime } = await import('@/lib/runtimes/claude-code');
    const result = await claudeCodeRuntime.launch({
      cwd: repoPath,
      prompt: 'implement the packet',
      model: 'claude-sonnet-4-5',
      laneId: 'lane-claude',
    });

    expect(result.ok, result.note).toBe(true);
    expect(ensureDispatchBackendReadyMock).toHaveBeenCalledWith('claude-code', 'launch');
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const [command, args, options] = spawnMock.mock.calls[0]!;
    expect(command).toBe(process.platform === 'win32' ? process.execPath : '/usr/bin/nice');
    const argv = process.platform === 'win32' ? args : args.slice(2);
    expect(argv).toEqual([
      process.execPath,
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--include-partial-messages',
      '--model',
      'claude-sonnet-4-5',
    ]);
    expect(argv).not.toContain('-p');
    expect(argv).not.toContain('--print');
    expect(options.cwd).toBe(realpathSync(repoPath));
    expect(spawnMock.mock.results[0]?.value.stdin.end).toHaveBeenCalledWith(
      expect.stringContaining('implement the packet'),
      'utf8',
    );
  }, 20_000);

  it('passes the requested Claude model and effort to the stream-json launch argv', async () => {
    const { claudeCodeRuntime } = await import('@/lib/runtimes/claude-code');
    const result = await claudeCodeRuntime.launch({
      cwd: repoPath,
      prompt: 'implement the packet',
      model: 'claude-opus-4-8',
      effort: 'high',
      laneId: 'lane-claude',
    });

    expect(result.ok, result.note).toBe(true);
    expect(resolveDefaultWorkerEffortSyncMock).toHaveBeenCalledWith('claude-code', 'high');
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const [, args] = spawnMock.mock.calls[0]!;
    const argv = process.platform === 'win32' ? args : args.slice(2);
    expect(argv).toEqual([
      process.execPath,
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--include-partial-messages',
      '--model',
      'claude-opus-4-8',
      '--effort',
      'high',
    ]);
    expect(argv).not.toContain('-p');
    expect(argv).not.toContain('--print');
  }, 20_000);

  it('applies the default Claude worker effort when launch omits effort', async () => {
    resolveDefaultWorkerEffortSyncMock.mockReturnValue('max');
    const { claudeCodeRuntime } = await import('@/lib/runtimes/claude-code');
    const result = await claudeCodeRuntime.launch({
      cwd: repoPath,
      prompt: 'implement the packet',
      model: 'claude-opus-4-8',
      laneId: 'lane-claude',
    });

    expect(result.ok).toBe(true);
    expect(resolveDefaultWorkerEffortSyncMock).toHaveBeenCalledWith('claude-code', undefined);

    const [, args] = spawnMock.mock.calls[0]!;
    const argv = process.platform === 'win32' ? args : args.slice(2);
    expect(argv).toContain('--effort');
    expect(argv).toContain('max');
  }, 20_000);

  it('omits the Claude effort flag for adaptive effort', async () => {
    const { claudeCodeRuntime } = await import('@/lib/runtimes/claude-code');
    const result = await claudeCodeRuntime.launch({
      cwd: repoPath,
      prompt: 'implement the packet',
      model: 'claude-opus-4-8',
      effort: 'adaptive',
      laneId: 'lane-claude',
    });

    expect(result.ok).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const [, args] = spawnMock.mock.calls[0]!;
    const argv = process.platform === 'win32' ? args : args.slice(2);
    expect(argv).toContain('--model');
    expect(argv).toContain('claude-opus-4-8');
    expect(argv).not.toContain('--effort');
    expect(argv).not.toContain('-p');
    expect(argv).not.toContain('--print');
  }, 20_000);

  it('pins an OpenRouter model and gateway environment to the owned worker child', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-worker';
    const profile = await import('@/lib/claude-code/worker-profile');
    await profile.writeClaudeCodeWorkerProfile({
      source: 'openrouter',
      model: 'deepseek/deepseek-v4-pro-0813',
      codexModel: null,
    });
    const { claudeCodeRuntime } = await import('@/lib/runtimes/claude-code');
    const result = await claudeCodeRuntime.launch({
      cwd: repoPath,
      prompt: 'implement through the Claude Code harness',
      model: 'claude-sonnet-4-5',
      laneId: 'lane-gateway',
      spendCap: { carrier: 'openrouter', costUsd: 1, inputTokens: 500_000 },
    });

    expect(result.ok, result.note).toBe(true);
    const [, args, options] = spawnMock.mock.calls[0]!;
    const argv = process.platform === 'win32' ? args : args.slice(2);
    expect(argv).toContain('deepseek/deepseek-v4-pro-0813');
    expect(options.env).toMatchObject({
      ANTHROPIC_BASE_URL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\//),
      ANTHROPIC_AUTH_TOKEN: 'sk-or-test-worker',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek/deepseek-v4-pro-0813',
    });
    const sessionRoot = path.join(tempRoot, 'owned', result.sessionKey!.replace('claude-code-owned:', ''));
    const metadata = JSON.parse(readFileSync(path.join(sessionRoot, 'session.json'), 'utf8')) as {
      model?: string;
      runtimeConfig?: { modelSource?: string; spendCapCostUsd?: string; spendCapInputTokens?: string };
    };
    expect(metadata).toMatchObject({
      model: 'deepseek/deepseek-v4-pro-0813',
      runtimeConfig: { modelSource: 'openrouter', spendCapCostUsd: '1', spendCapInputTokens: '500000' },
    });
  }, 20_000);

  it('fails before spawning when the selected gateway has no key', async () => {
    const profile = await import('@/lib/claude-code/worker-profile');
    await profile.writeClaudeCodeWorkerProfile({ source: 'openrouter', model: 'x-ai/grok-4.6', codexModel: null });
    const { claudeCodeRuntime } = await import('@/lib/runtimes/claude-code');
    const result = await claudeCodeRuntime.launch({
      cwd: repoPath,
      prompt: 'do not start without credentials',
      laneId: 'lane-no-key',
    });

    expect(result).toMatchObject({ ok: false, sideEffect: 'none' });
    expect(result.note).toContain('OpenRouter API key');
    expect(spawnMock).not.toHaveBeenCalled();
  }, 20_000);

  it('pins the selected Codex subscription model and isolated localhost carrier to the worker', async () => {
    const profile = await import('@/lib/claude-code/worker-profile');
    await profile.writeClaudeCodeWorkerProfile({
      source: 'codex-subscription',
      model: null,
      codexModel: 'gpt-5.6-sol',
    });
    const { claudeCodeRuntime } = await import('@/lib/runtimes/claude-code');
    const result = await claudeCodeRuntime.launch({
      cwd: repoPath,
      prompt: 'use the Codex subscription through the Claude Code harness',
      model: 'claude-opus-4-8',
      laneId: 'lane-codex-carrier',
    });

    expect(result.ok).toBe(true);
    expect(ensureCodexSubscriptionProxyReadyMock).toHaveBeenCalled();
    const [, args, options] = spawnMock.mock.calls[0]!;
    const argv = process.platform === 'win32' ? args : args.slice(2);
    expect(argv).toContain('gpt-5.6-sol');
    expect(argv).not.toContain('claude-opus-4-8');
    expect(options.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317',
      ANTHROPIC_AUTH_TOKEN: 'local-codex-test-token',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      CLAUDE_CODE_SUBAGENT_MODEL: 'gpt-5.6-sol',
      CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1',
      ENABLE_TOOL_SEARCH: 'false',
      CLAUDE_CONFIG_DIR: expect.stringContaining('claude-code-codex-config'),
    });
    const sessionRoot = path.join(tempRoot, 'owned', result.sessionKey!.replace('claude-code-owned:', ''));
    const metadata = JSON.parse(readFileSync(path.join(sessionRoot, 'session.json'), 'utf8')) as {
      model?: string;
      runtimeConfig?: { modelSource?: string };
    };
    expect(metadata).toMatchObject({
      model: 'gpt-5.6-sol',
      runtimeConfig: { modelSource: 'codex-subscription' },
    });
  }, 20_000);
});
