/**
 * The argv a read-only Claude Code worker is actually spawned with.
 *
 * `tests/read-only-worker-enforcement.test.ts` proves the persisted read-only
 * mode reaches the runtime as dispatch metadata. This proves what the runtime
 * then does with it: the real owned-session store runs, and the argv handed to
 * `spawn` carries the CLI-level deny rule that makes the write tools
 * unreachable. The write packet is the control — its argv must not change.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
const spawnBridgeMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

vi.mock('@/lib/runtimes/shared/dispatch-readiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/dispatch-readiness')>();
  return { ...actual, ensureDispatchBackendReady: vi.fn(async () => ({ ready: true, reason: 'http_200' })) };
});

// The worker config dir seeds real operator credentials; the argv contract does
// not depend on it, so keep the fixture credential-free.
vi.mock('@/lib/claude-code/codex-subscription-proxy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/claude-code/codex-subscription-proxy')>();
  return {
    ...actual,
    ensureClaudeCodeWorkerConfigDir: vi.fn(async (sessionDir: string) => sessionDir),
  };
});

vi.mock('@/lib/runtime/pty-bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtime/pty-bridge')>();
  return { ...actual, spawnBridgeTerminalSession: spawnBridgeMock };
});

vi.mock('@/lib/workspace/materialization-guard', () => ({
  inspectOwnedWorkspaceMaterialization: vi.fn(async () => ({
    status: 'available',
    source: 'no-snapshot',
  })),
}));

vi.mock('@/lib/mcp/worker-injection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mcp/worker-injection')>();
  return {
    ...actual,
    resolveWorkerMcpInjection: vi.fn(async () => ({
      servers: [{
        id: 'packet-observer',
        name: 'packet-observer',
        command: process.execPath,
        args: [],
        env: null,
      }],
      skipped: [],
    })),
  };
});

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-read-only-argv-'));
const repoPath = path.join(tempRoot, 'repo');
execFileSync('git', ['init', '-q', repoPath]);
// The owned-session workspace guard only allows launches under HOME or the
// configured data dir, so the fixture repo lives inside the data dir.
process.env.CORTEX_IDE_DATA_DIR = tempRoot;
process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT = path.join(tempRoot, 'sessions');
process.env.O8_CLAUDE_CODE_BIN = process.execPath;

const { launchOwnedClaudeCodeSession, claudeCodeOwnedAdapter } = await import('./owned');
const { CLAUDE_READ_ONLY_DISALLOWED_TOOLS, CLAUDE_STRICT_MCP_CONFIG_FLAG } = await import('./read-only-args');
const { SANDBOX_EXEC_PATH } = await import('@/lib/runtimes/shared/owned-session/sandbox');

beforeEach(() => {
  spawnMock.mockReturnValue({ pid: 4242, unref: vi.fn(), once: vi.fn() });
  spawnBridgeMock.mockRejectedValue(new Error('bridge unavailable'));
});

afterEach(() => {
  spawnMock.mockReset();
  spawnBridgeMock.mockReset();
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

async function spawnedArgs(workMode?: 'read-only'): Promise<string[]> {
  const result = await launchOwnedClaudeCodeSession({
    cwd: repoPath,
    prompt: 'inspect the repository',
    ...(workMode ? { workMode } : {}),
  });
  expect(result, result.note).toMatchObject({ ok: true });
  expect(spawnMock).toHaveBeenCalled();
  return spawnMock.mock.calls[spawnMock.mock.calls.length - 1]?.[1] as string[];
}

describe('owned Claude Code read-only argv', () => {
  it('denies the native write tools for a read-only launch', async () => {
    const args = await spawnedArgs('read-only');
    const denyIndex = args.indexOf('--disallowedTools');
    expect(denyIndex).toBeGreaterThan(-1);
    for (const tool of CLAUDE_READ_ONLY_DISALLOWED_TOOLS) {
      expect(args.indexOf(tool)).toBeGreaterThan(denyIndex);
    }
  });

  it('pins --strict-mcp-config so user-scope MCP servers cannot merge in write tools', async () => {
    // --disallowedTools names the NATIVE write tools only. A user-scope MCP
    // server merged in from ~/.claude.json contributes `mcp__<server>__*` tools
    // the deny list does not cover, and those can write files. Strict mode
    // honours ONLY the packet's generated --mcp-config.
    const args = await spawnedArgs('read-only');
    expect(args).toContain(CLAUDE_STRICT_MCP_CONFIG_FLAG);
  });

  it('leaves a normal write launch without any deny rule or strict MCP pin', async () => {
    const args = await spawnedArgs();
    expect(args).not.toContain('--disallowedTools');
    expect(args).not.toContain(CLAUDE_STRICT_MCP_CONFIG_FLAG);
    for (const tool of CLAUDE_READ_ONLY_DISALLOWED_TOOLS) {
      expect(args).not.toContain(tool);
    }
  });

  it.skipIf(process.platform !== 'darwin')(
    'write-denies the worktree in the generated sandbox profile when sandboxing is on',
    async () => {
      process.env.O8_WORKER_SANDBOX = 'on';
      try {
        const args = await spawnedArgs('read-only');
        // The spawn is nice-wrapped, so sandbox-exec appears inside argv:
        // [... , sandbox-exec, '-f', <profile>, <claude binary>, ...claudeArgs]
        const sandboxIdx = args.indexOf(SANDBOX_EXEC_PATH);
        expect(sandboxIdx).toBeGreaterThan(-1);
        expect(args[sandboxIdx + 1]).toBe('-f');
        const profile = readFileSync(args[sandboxIdx + 2]!, 'utf8');
        const allowIdx = profile.indexOf(';; --- read+write: packet, Git metadata, TMPDIR, and tool state ---');
        const denyIdx = profile.indexOf(';; read-only packet: repository stays readable');
        expect(denyIdx).toBeGreaterThan(allowIdx);
        expect(profile.slice(denyIdx)).toContain(`(subpath "${realpathSync(repoPath)}")`);
      } finally {
        delete process.env.O8_WORKER_SANDBOX;
      }
    },
  );

  it.skipIf(process.platform !== 'darwin')(
    're-opens only the generated MCP config after the relocated data-root deny',
    async () => {
      const result = await launchOwnedClaudeCodeSession({
        cwd: repoPath,
        prompt: 'inspect with the attached packet server',
        packetId: 'pkt-read-only-mcp-config',
        workMode: 'read-only',
      });
      expect(result, result.note).toMatchObject({ ok: true });
      const args = spawnMock.mock.calls[spawnMock.mock.calls.length - 1]?.[1] as string[];
      const sandboxIdx = args.indexOf(SANDBOX_EXEC_PATH);
      const configIdx = args.indexOf('--mcp-config');
      expect(sandboxIdx).toBeGreaterThan(-1);
      expect(configIdx).toBeGreaterThan(sandboxIdx);
      const profilePath = args[sandboxIdx + 2]!;
      const configPath = args[configIdx + 1]!;
      expect(existsSync(configPath)).toBe(true);

      const profile = readFileSync(profilePath, 'utf8');
      const secretRootDeny = profile.indexOf(`(subpath "${realpathSync(tempRoot)}")`);
      const exactConfigAllow = profile.lastIndexOf(`(literal "${configPath}")`);
      expect(secretRootDeny).toBeGreaterThan(-1);
      expect(exactConfigAllow).toBeGreaterThan(secretRootDeny);
      expect(profile.slice(secretRootDeny)).not.toContain(`(subpath "${path.dirname(configPath)}")`);

      const config = execFileSync(SANDBOX_EXEC_PATH, [
        '-f', profilePath, '/bin/cat', configPath,
      ], { encoding: 'utf8' });
      expect(config).toContain('"packet-observer"');

      const siblingSecret = path.join(path.dirname(configPath), 'worker-token');
      writeFileSync(siblingSecret, 'MUST_NOT_READ\n');
      expect(() => execFileSync(SANDBOX_EXEC_PATH, [
        '-f', profilePath, '/bin/cat', siblingSecret,
      ], { stdio: ['ignore', 'pipe', 'ignore'] })).toThrow();
    },
  );

  it('builds the deny rule from the session runtimeConfig pin, not the caller', () => {
    const base = { cwd: repoPath, prompt: 'inspect' };
    expect(claudeCodeOwnedAdapter.launchArgs({ ...base, runtimeConfig: { workMode: 'read-only' } }))
      .toContain('--disallowedTools');
    expect(claudeCodeOwnedAdapter.launchArgs({ ...base, runtimeConfig: { workMode: 'read-only' } }))
      .toContain(CLAUDE_STRICT_MCP_CONFIG_FLAG);
    expect(claudeCodeOwnedAdapter.launchArgs({ ...base, runtimeConfig: { modelSource: 'native' } }))
      .not.toContain('--disallowedTools');
    expect(claudeCodeOwnedAdapter.launchArgs({ ...base, runtimeConfig: { modelSource: 'native' } }))
      .not.toContain(CLAUDE_STRICT_MCP_CONFIG_FLAG);
  });
});
