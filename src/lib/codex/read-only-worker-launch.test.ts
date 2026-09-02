/**
 * The argv a read-only Codex worker is actually spawned with.
 *
 * Codex is the DEFAULT worker runtime, so this is the path almost every real
 * dispatch takes. Before this, a read-only packet dispatched to Codex still
 * launched with `--dangerously-bypass-approvals-and-sandbox -s
 * danger-full-access` — read-only in prompt only.
 *
 * The real owned-session store runs here; the assertions are on the argv handed
 * to `spawn`. The write packet is the control — its argv must not change.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
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

vi.mock('@/lib/runtime/pty-bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtime/pty-bridge')>();
  return { ...actual, spawnBridgeTerminalSession: spawnBridgeMock };
});

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-codex-read-only-argv-'));
const repoPath = path.join(tempRoot, 'repo');
execFileSync('git', ['init', '-q', repoPath]);
// The owned-session workspace guard only allows launches under HOME or the
// configured data dir, so the fixture repo lives inside the data dir.
process.env.CORTEX_IDE_DATA_DIR = tempRoot;
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = path.join(tempRoot, 'sessions');
process.env.O8_CODEX_BIN = process.execPath;

const { launchOwnedCodexSession, codexLaunchArgs, codexResumeArgs } = await import('./owned');
const {
  CODEX_FULL_ACCESS_LAUNCH_FLAGS,
  CODEX_READ_ONLY_LAUNCH_FLAGS,
  CODEX_READ_ONLY_RESUME_FLAGS,
} = await import('./read-only-args');
const { SANDBOX_EXEC_PATH } = await import('@/lib/runtimes/shared/owned-session/sandbox');

beforeEach(() => {
  spawnMock.mockReturnValue({ pid: 5252, unref: vi.fn(), once: vi.fn() });
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
  const result = await launchOwnedCodexSession({
    cwd: repoPath,
    prompt: 'inspect the repository',
    ...(workMode ? { workMode } : {}),
  });
  expect(result, result.note).toMatchObject({ ok: true });
  expect(spawnMock).toHaveBeenCalled();
  return spawnMock.mock.calls[spawnMock.mock.calls.length - 1]?.[1] as string[];
}

/** Index of a contiguous run of args, or -1. */
function indexOfSequence(args: string[], sequence: readonly string[]): number {
  for (let i = 0; i + sequence.length <= args.length; i += 1) {
    if (sequence.every((value, offset) => args[i + offset] === value)) return i;
  }
  return -1;
}

describe('owned Codex read-only argv', () => {
  it('launches a read-only packet with approvals off and no nested inner sandbox', async () => {
    const args = await spawnedArgs('read-only');
    expect(indexOfSequence(args, CODEX_READ_ONLY_LAUNCH_FLAGS)).toBeGreaterThan(-1);
    // The blanket bypass flag must be gone entirely, not merely reordered: it
    // also disables approvals implicitly, and we set that policy explicitly.
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    // Codex's OWN sandbox stays off on purpose — nesting sandbox-exec inside
    // o8's forced profile fails with exit 71 (sandbox_apply: Operation not
    // permitted), killing every exec_command the read-only packet needs.
    expect(args).not.toContain('read-only');
  });

  it('leaves a normal write launch on the previous full-access flags (control)', async () => {
    const args = await spawnedArgs();
    expect(indexOfSequence(args, CODEX_FULL_ACCESS_LAUNCH_FLAGS)).toBeGreaterThan(-1);
    expect(args).not.toContain('approval_policy="never"');
  });

  it.skipIf(process.platform !== 'darwin')(
    'forces the OS sandbox for a read-only Codex packet even with O8_WORKER_SANDBOX off',
    async () => {
      // The argv policy is Codex's own; the kernel denial is o8's. A read-only
      // packet gets BOTH, and the seatbelt layer is not gated on the opt-in
      // env var the way a normal packet's hardening is.
      delete process.env.O8_WORKER_SANDBOX;
      const args = await spawnedArgs('read-only');
      const sandboxIdx = args.indexOf(SANDBOX_EXEC_PATH);
      expect(sandboxIdx).toBeGreaterThan(-1);
      expect(args[sandboxIdx + 1]).toBe('-f');
      const profile = readFileSync(args[sandboxIdx + 2]!, 'utf8');
      const allowIdx = profile.indexOf(';; --- read+write: packet, Git metadata, TMPDIR, and tool state ---');
      const denyIdx = profile.indexOf(';; read-only packet: repository stays readable');
      expect(denyIdx).toBeGreaterThan(allowIdx);
      expect(profile.slice(denyIdx)).toContain(`(subpath "${realpathSync(repoPath)}")`);
    },
  );

  it.skipIf(process.platform !== 'darwin')(
    'does not force the OS sandbox for a normal write packet (control)',
    async () => {
      delete process.env.O8_WORKER_SANDBOX;
      const args = await spawnedArgs();
      expect(args).not.toContain(SANDBOX_EXEC_PATH);
    },
  );

  it.skipIf(process.platform !== 'darwin')(
    'proves WHY Codex must not apply its own sandbox: nesting sandbox-exec fails',
    async () => {
      // Recurrence protection. `-s read-only` is the obvious "fix" a future
      // reader will reach for. It cannot work: a read-only packet is ALWAYS
      // already wrapped in o8's forced seatbelt profile, and a second
      // sandbox-exec inside it cannot acquire the sandbox.
      const { prepareWorkerSandbox } = await import('@/lib/runtimes/shared/owned-session/sandbox');
      const innerProfileDir = mkdtempSync(path.join(os.tmpdir(), 'o8-codex-inner-profile-'));
      const innerProfile = path.join(innerProfileDir, 'inner.sb');
      writeFileSync(innerProfile, '(version 1)\n(allow default)\n');
      const prepared = await prepareWorkerSandbox({
        runId: 'codex-nesting-proof',
        profileDir: mkdtempSync(path.join(os.tmpdir(), 'o8-codex-nest-')),
        cwd: repoPath,
        repoPath,
        binary: '/bin/sh',
        args: [],
        extraReadPaths: [innerProfile],
        enforceReadOnly: true,
      });
      const outerProfile = prepared.args[1]!;

      try {
        // A plain read inside the outer profile works…
        expect(execFileSync(SANDBOX_EXEC_PATH, [
          '-f', outerProfile, '/bin/echo', 'reachable',
        ], { encoding: 'utf8' })).toContain('reachable');

        // …but the same command behind a nested sandbox-exec dies with exit 71.
        let nestedStatus: number | undefined;
        try {
          execFileSync(SANDBOX_EXEC_PATH, [
            '-f', outerProfile, SANDBOX_EXEC_PATH, '-f', innerProfile, '/bin/echo', 'nested',
          ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
          nestedStatus = (error as { status?: number }).status;
        }
        expect(nestedStatus).toBe(71);
      } finally {
        rmSync(innerProfileDir, { recursive: true, force: true });
      }
    },
  );

  it('reads the mode from the session runtimeConfig pin, not the caller', () => {
    // The pin is what makes retry/resume/rerun stay read-only when the caller
    // no longer supplies the mode.
    const base = { cwd: repoPath, prompt: 'inspect' };
    expect(indexOfSequence(
      codexLaunchArgs({ ...base, runtimeConfig: { workMode: 'read-only' } }),
      CODEX_READ_ONLY_LAUNCH_FLAGS,
    )).toBeGreaterThan(-1);
    expect(indexOfSequence(
      codexLaunchArgs({ ...base, runtimeConfig: { modelSource: 'native' } }),
      CODEX_FULL_ACCESS_LAUNCH_FLAGS,
    )).toBeGreaterThan(-1);
  });

  it('keeps a resumed read-only turn read-only without the unsupported -s flag', () => {
    // `codex exec resume` has no -s/--sandbox flag (#1415), so the same policy
    // has to travel as -c config overrides.
    const resume = codexResumeArgs({
      threadId: 'thread-1',
      prompt: 'keep inspecting',
      runtimeConfig: { workMode: 'read-only' },
    });
    expect(indexOfSequence(resume, CODEX_READ_ONLY_RESUME_FLAGS)).toBeGreaterThan(-1);
    expect(resume).not.toContain('-s');
    expect(resume).not.toContain('--dangerously-bypass-approvals-and-sandbox');

    const writeResume = codexResumeArgs({ threadId: 'thread-1', prompt: 'keep working' });
    expect(writeResume).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(writeResume).not.toContain('approval_policy="never"');
  });
});
