import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const spawnMock = vi.hoisted(() => vi.fn());
const authStatusMock = vi.hoisted(() => ({ loggedIn: true }));
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
    execFile: ((file: string, args: string[], options: unknown, callback: (...args: unknown[]) => void) => {
      if (file === '/usr/bin/security') {
        const error = Object.assign(new Error('test keychain item unavailable'), { code: 44 });
        callback(error, '', '');
        return {};
      }
      if (args[0] === 'auth' && args[1] === 'status') {
        callback(null, JSON.stringify({ loggedIn: authStatusMock.loggedIn }), '');
        return {};
      }
      return actual.execFile(file, args, options as Parameters<typeof actual.execFile>[2], callback);
    }) as typeof actual.execFile,
    spawn: (...args: Parameters<typeof actual.spawn>) => (
      Array.isArray(args[1]) && args[1].includes('--input-format')
        ? spawnMock(...args)
        : actual.spawn(...args)
    ),
  };
});

vi.mock('@/lib/runtimes/shared/dispatch-readiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/dispatch-readiness')>();
  return { ...actual, ensureDispatchBackendReady: ensureDispatchBackendReadyMock };
});

describe('Claude Code worker skill isolation real path', () => {
  const priorEnv: Record<string, string | undefined> = {};
  let tempRoot: string;
  let repoPath: string;
  let fakeHome: string;
  const listeners = new Map<string, (...args: unknown[]) => void>();

  beforeAll(() => {
    tempRoot = mkdtempSync(path.join(os.homedir(), '.tmp-o8-claude-skill-isolation-'));
    fakeHome = path.join(tempRoot, 'operator-home');
    repoPath = path.join(fakeHome, 'repo');
    const dataDir = path.join(tempRoot, 'data');
    mkdirSync(dataDir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);

    const title = 'Stop workers loading matching operator skills';
    const fakeUserSkill = path.join(fakeHome, '.claude', 'skills', 'matching-trigger');
    mkdirSync(fakeUserSkill, { recursive: true });
    writeFileSync(path.join(fakeUserSkill, 'SKILL.md'), [
      '---',
      'name: matching-trigger',
      `description: Use whenever the task says "${title}".`,
      '---',
      'Load a large unrelated reference tree.',
    ].join('\n'));
    writeFileSync(
      path.join(fakeHome, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'operator-real-oauth-token' } }),
    );

    for (const key of [
      'HOME',
      'O8_DATA_DIR',
      'CORTEX_IDE_DATA_DIR',
      'CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT',
      'O8_CLAUDE_CODE_BIN',
    ]) {
      priorEnv[key] = process.env[key];
    }
    process.env.HOME = fakeHome;
    process.env.O8_DATA_DIR = dataDir;
    process.env.CORTEX_IDE_DATA_DIR = dataDir;
    process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT = path.join(tempRoot, 'owned');
    process.env.O8_CLAUDE_CODE_BIN = process.execPath;

    spawnMock.mockImplementation(() => {
      const child = {
        pid: 4242,
        stdin: { end: vi.fn() },
        unref: vi.fn(),
        once: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
          listeners.set(event, callback);
          return child;
        }),
      };
      return child;
    });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true })));
  });

  afterAll(() => {
    spawnMock.mockReset();
    vi.unstubAllGlobals();
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('isolates config, disables skill discovery, carries the prompt boundary, and records turn context', async () => {
    const title = 'Stop workers loading matching operator skills';
    const packetId = 'pkt-claude-skill-isolation';
    const { writeClaudeCodeWorkerProfile } = await import('@/lib/claude-code/worker-profile');
    const { buildPacketPrompt } = await import('@/lib/orchestrator/packet-prompt');
    const { createLane, getLaneEvents } = await import('@/lib/lane/registry');
    const { claudeCodeRuntime } = await import('@/lib/runtimes/claude-code');

    await writeClaudeCodeWorkerProfile({
      source: 'native',
      model: null,
      codexModel: null,
      repoSkillAllowlist: [],
    });
    const packet = {
      id: packetId,
      referenceLabel: 'PKT-SKILL-ISOLATION',
      title,
      summary: 'Verify the real Claude worker launch boundary.',
      status: 'draft',
      queueState: 'queued',
      releaseState: 'pending',
      blockedReason: null,
      lane: null,
      review: null,
      runtime: 'claude-code',
      workspaceTargetPath: repoPath,
      branchTarget: 'test/skill-isolation',
      dependencyPacketIds: [],
      dependencyLabels: [],
      attemptCount: 0,
      lastEventAt: new Date().toISOString(),
      lastEventLabel: 'created',
      recoveryCount: 0,
      typecheckAutoRetries: 0,
      orchestratorThreadId: null,
    } as OrchestratorPacket;
    const prompt = await buildPacketPrompt(packet, [], 'main', repoPath);
    const lane = createLane({
      repoPath,
      worktreePath: repoPath,
      branch: packet.branchTarget,
      runtime: 'claude-code',
      label: title,
      packetId,
    });

    const result = await claudeCodeRuntime.launch({
      cwd: repoPath,
      laneId: lane.id,
      prompt,
    });

    if (!result.ok) throw new Error(result.note);
    const [, args, options] = spawnMock.mock.calls[0]!;
    const configDir = options.env.CLAUDE_CONFIG_DIR as string;
    expect(configDir.startsWith(fakeHome)).toBe(false);
    expect(existsSync(configDir)).toBe(true);
    expect(existsSync(path.join(configDir, 'skills'))).toBe(false);
    expect(args).toContain('--disable-slash-commands');

    // Native carrier: the isolated config dir must be seeded with a copy of
    // the operator's real credentials (Claude Code stores OAuth creds at
    // <config dir>/.credentials.json), so the worker doesn't spawn logged out.
    const sourceCredentialsPath = path.join(fakeHome, '.claude', '.credentials.json');
    const seededCredentialsPath = path.join(configDir, '.credentials.json');
    expect(existsSync(seededCredentialsPath)).toBe(true);
    expect(readFileSync(seededCredentialsPath, 'utf8')).toBe(readFileSync(sourceCredentialsPath, 'utf8'));
    expect(statSync(seededCredentialsPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(sourceCredentialsPath, 'utf8')).toContain('operator-real-oauth-token');
    expect(prompt).toContain('Claude Code skills are unavailable in this dispatched worker.');
    expect(prompt).not.toContain('Load a large unrelated reference tree.');
    expect(spawnMock.mock.results[0]?.value.stdin.end).toHaveBeenCalledWith(
      expect.stringContaining('Claude Code skills are unavailable in this dispatched worker.'),
      'utf8',
    );

    const surfaceId = result.sessionKey!;
    const sessionDir = path.join(tempRoot, 'owned', surfaceId.replace('claude-code-owned:', ''));
    const session = JSON.parse(readFileSync(path.join(sessionDir, 'session.json'), 'utf8')) as {
      recentRuns: Array<{ stdoutPath: string }>;
    };
    writeFileSync(session.recentRuns[0]!.stdoutPath, `${JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'done',
      session_id: 'claude-turn-isolation',
      usage: {
        input_tokens: 203,
        output_tokens: 11,
        cache_read_input_tokens: 40_448,
      },
    })}\n`);
    listeners.get('exit')?.(0, null);
    listeners.get('close')?.(0, null);

    const exitEvent = await waitFor(() => getLaneEvents(lane.id, 200)
      .find((event) => event.verb === 'runtime_process_exit' && event.payload.runId));
    expect(exitEvent?.payload).toMatchObject({
      inputTokens: 203,
      cacheReadTokens: 40_448,
      contextTokens: 40_651,
    });
  }, 30_000);

  it('fails the persisted dispatch path before spawn when no live credential can be seeded', async () => {
    const noCredsHome = path.join(tempRoot, 'operator-home-no-creds');
    mkdirSync(path.join(noCredsHome, '.claude'), { recursive: true });
    const noCredsRepoPath = path.join(noCredsHome, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', noCredsRepoPath]);

    const { writeClaudeCodeWorkerProfile } = await import('@/lib/claude-code/worker-profile');
    const { buildPacketPrompt } = await import('@/lib/orchestrator/packet-prompt');
    const { createLane, getLane, getLaneEvents } = await import('@/lib/lane/registry');
    const { dispatch: dispatchLaneCommand } = await import('@/lib/lane/commands');

    await writeClaudeCodeWorkerProfile({
      source: 'native',
      model: null,
      codexModel: null,
      repoSkillAllowlist: [],
    });

    const packetId = 'pkt-claude-no-source-credentials';
    const packet = {
      id: packetId,
      referenceLabel: 'PKT-NO-CREDS',
      title: 'Verify spawn proceeds without a source credentials file',
      summary: 'Verify the real Claude worker launch boundary when the operator has no credentials file.',
      status: 'draft',
      queueState: 'queued',
      releaseState: 'pending',
      blockedReason: null,
      lane: null,
      review: null,
      runtime: 'claude-code',
      workspaceTargetPath: noCredsRepoPath,
      branchTarget: 'test/no-source-credentials',
      dependencyPacketIds: [],
      dependencyLabels: [],
      attemptCount: 0,
      lastEventAt: new Date().toISOString(),
      lastEventLabel: 'created',
      recoveryCount: 0,
      typecheckAutoRetries: 0,
      orchestratorThreadId: null,
    } as OrchestratorPacket;
    const prompt = await buildPacketPrompt(packet, [], 'main', noCredsRepoPath);
    const lane = createLane({
      repoPath: noCredsRepoPath,
      worktreePath: noCredsRepoPath,
      branch: packet.branchTarget,
      runtime: 'claude-code',
      label: packet.title,
      packetId,
    });

    const callCountBefore = spawnMock.mock.calls.length;
    const priorHome = process.env.HOME;
    process.env.HOME = noCredsHome;
    let result: Awaited<ReturnType<typeof dispatchLaneCommand>>;
    try {
      result = await dispatchLaneCommand({
        verb: 'launch_session',
        laneId: lane.id,
        prompt,
        actor: 'orchestrator',
      });
    } finally {
      process.env.HOME = priorHome;
    }

    expect(result).toMatchObject({ ok: false });
    expect(result.note).toContain('worker_not_authenticated');
    expect(result.note).toContain('No worker was started');
    expect(spawnMock.mock.calls.length).toBe(callCountBefore);
    expect(getLane(lane.id)?.status).toBe('idle');
    expect(getLaneEvents(lane.id, 200)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        verb: 'worker_not_authenticated',
        payload: expect.objectContaining({
          runtime: 'claude-code',
          code: 'worker_not_authenticated',
        }),
      }),
      expect.objectContaining({
        verb: 'status_change',
        payload: expect.objectContaining({ eventLabel: 'launch_error' }),
      }),
    ]));
  }, 30_000);

  it('rejects a seeded credential when Claude Code reports the isolated config is logged out', async () => {
    const { ensureClaudeCodeWorkerConfigDir } = await import('@/lib/claude-code/codex-subscription-proxy');
    authStatusMock.loggedIn = false;
    try {
      await expect(ensureClaudeCodeWorkerConfigDir(
        path.join(tempRoot, 'rejected-credential-session'),
        'native',
      )).rejects.toMatchObject({
        code: 'worker_not_authenticated',
        reason: 'Claude Code rejected the seeded credential.',
      });
    } finally {
      authStatusMock.loggedIn = true;
    }
  });

  it('injects only explicitly allowlisted repository skill instructions', async () => {
    const allowedSkill = path.join(repoPath, '.claude', 'skills', 'review-only');
    const blockedSkill = path.join(repoPath, '.claude', 'skills', 'unlisted');
    mkdirSync(allowedSkill, { recursive: true });
    mkdirSync(blockedSkill, { recursive: true });
    writeFileSync(path.join(allowedSkill, 'SKILL.md'), 'ALLOWLISTED_REVIEW_INSTRUCTIONS');
    writeFileSync(path.join(blockedSkill, 'SKILL.md'), 'UNLISTED_SKILL_INSTRUCTIONS');

    const { writeClaudeCodeWorkerProfile } = await import('@/lib/claude-code/worker-profile');
    const { buildPacketPrompt } = await import('@/lib/orchestrator/packet-prompt');
    await writeClaudeCodeWorkerProfile({
      source: 'native',
      model: null,
      codexModel: null,
      repoSkillAllowlist: ['review-only'],
    });
    const prompt = await buildPacketPrompt({
      id: 'pkt-claude-allowlisted-skill',
      referenceLabel: 'PKT-ALLOWLIST',
      title: 'Run an allowlisted review',
      summary: 'Verify explicit repository skill injection.',
      status: 'draft',
      queueState: 'queued',
      releaseState: 'pending',
      blockedReason: null,
      lane: null,
      review: null,
      runtime: 'claude-code',
      workspaceTargetPath: repoPath,
      branchTarget: 'test/allowlisted-skill',
      dependencyPacketIds: [],
      dependencyLabels: [],
      attemptCount: 0,
      lastEventAt: new Date().toISOString(),
      lastEventLabel: 'created',
      recoveryCount: 0,
      typecheckAutoRetries: 0,
      orchestratorThreadId: null,
    } as OrchestratorPacket, [], 'main', repoPath);

    expect(prompt).toContain('Operator-allowlisted repository skill "review-only"');
    expect(prompt).toContain('ALLOWLISTED_REVIEW_INSTRUCTIONS');
    expect(prompt).not.toContain('UNLISTED_SKILL_INSTRUCTIONS');
  });
});

async function waitFor<T>(read: () => T | undefined, timeoutMs = 3_000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return undefined;
}
