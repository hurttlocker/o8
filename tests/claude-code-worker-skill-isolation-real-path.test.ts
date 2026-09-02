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
    execFileSync('git', [
      '-c', 'user.email=test@o8.test',
      '-c', 'user.name=o8-test',
      'commit', '--allow-empty', '-m', 'seed',
    ], { cwd: repoPath });

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

  it('isolates five real dispatches, disables skill discovery, and projects bounded turn context to the packet card', async () => {
    const title = 'Stop workers loading matching operator skills';
    const packetId = 'pkt-claude-skill-isolation';
    const { writeClaudeCodeWorkerProfile } = await import('@/lib/claude-code/worker-profile');
    const { buildPacketPrompt } = await import('@/lib/orchestrator/packet-prompt');
    const { createLane, getLane, getLaneEvents } = await import('@/lib/lane/registry');
    const { addRepo } = await import('@/lib/repos/registry');
    const { captureWorktreeMaterializationIdentity } = await import('@/lib/worktree/materialization-identity');
    const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
    const { managedPacketWorktreeId } = await import('@/lib/worktree/root-layout');
    const { dispatch: dispatchLaneCommand } = await import('@/lib/lane/commands');
    const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
    const {
      syncOrchestratorControlPlaneState,
      writeOrchestratorControlPlaneState,
    } = await import('@/lib/orchestrator/control-plane');

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
    await addRepo(repoPath);
    const worktreeId = managedPacketWorktreeId(packetId);
    if (!worktreeId) throw new Error('Packet worktree id was not created.');
    const worktreeBase = path.join(repoPath, '.cortex-worktrees');
    const worktreePath = path.join(worktreeBase, worktreeId);
    mkdirSync(worktreeBase, { recursive: true });
    execFileSync('git', ['worktree', 'add', worktreePath, '-b', packet.branchTarget], { cwd: repoPath });
    const materializationIdentity = await captureWorktreeMaterializationIdentity(worktreePath);
    const materializationParentIdentity = await captureWorktreeMaterializationIdentity(worktreeBase);
    await withWorktreeMetaTransaction(repoPath, (transaction) => transaction.save(worktreeId, {
      id: worktreeId,
      agentType: 'claude-code',
      baseBranch: 'main',
      createdAt: Date.now(),
      claudeManaged: false,
      taskName: title,
      branchName: packet.branchTarget,
      status: 'ready',
      isolationKind: 'git-worktree',
      materializationIdentity,
      materializationParentIdentity,
    }));
    const lane = createLane({
      repoPath,
      worktreePath,
      branch: packet.branchTarget,
      runtime: 'claude-code',
      label: title,
      packetId,
    });
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-claude-skill-isolation',
      repoPath,
      runtime: 'claude-code',
      packets: [packet],
    });
    expect(prompt).toContain('Claude Code skills are unavailable in this dispatched worker.');
    expect(prompt).not.toContain('Load a large unrelated reference tree.');
    const contextByTurn = [40_651, 41_024, 41_809, 42_331, 43_007];
    const launchCallStart = spawnMock.mock.calls.length;

    for (const [turnIndex, contextTokens] of contextByTurn.entries()) {
      const inputTokens = 203 + turnIndex;
      const result = await dispatchLaneCommand({
        verb: 'launch_session',
        laneId: lane.id,
        prompt,
        actor: 'orchestrator',
      });
      if (!result.ok) throw new Error(result.note);

      const spawnCallIndex = launchCallStart + turnIndex;
      const [, args, options] = spawnMock.mock.calls[spawnCallIndex]!;
      const configDir = options.env.CLAUDE_CONFIG_DIR as string;
      expect(configDir.startsWith(fakeHome)).toBe(false);
      expect(existsSync(configDir)).toBe(true);
      expect(existsSync(path.join(configDir, 'skills'))).toBe(false);
      expect(args).toContain('--disable-slash-commands');
      expect(spawnMock.mock.results[spawnCallIndex]?.value.stdin.end).toHaveBeenCalledWith(
        expect.stringContaining('Claude Code skills are unavailable in this dispatched worker.'),
        'utf8',
      );

      // Native carrier: the isolated config dir must be seeded with a copy of
      // the operator's real credentials, but never their skills directory.
      const sourceCredentialsPath = path.join(fakeHome, '.claude', '.credentials.json');
      const seededCredentialsPath = path.join(configDir, '.credentials.json');
      expect(existsSync(seededCredentialsPath)).toBe(true);
      expect(readFileSync(seededCredentialsPath, 'utf8')).toBe(readFileSync(sourceCredentialsPath, 'utf8'));
      expect(statSync(seededCredentialsPath).mode & 0o777).toBe(0o600);

      const surfaceId = getLane(lane.id)?.sessionKey;
      if (!surfaceId) throw new Error(`Turn ${turnIndex + 1} did not attach a session.`);
      const sessionDir = path.join(tempRoot, 'owned', surfaceId.replace('claude-code-owned:', ''));
      const session = JSON.parse(readFileSync(path.join(sessionDir, 'session.json'), 'utf8')) as {
        recentRuns: Array<{ stdoutPath: string }>;
      };
      const exitCountBefore = getLaneEvents(lane.id, 200)
        .filter((event) => event.verb === 'runtime_process_exit').length;
      writeFileSync(session.recentRuns[0]!.stdoutPath, `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'done',
        session_id: `claude-turn-isolation-${turnIndex + 1}`,
        usage: {
          input_tokens: inputTokens,
          output_tokens: 11,
          cache_read_input_tokens: contextTokens - inputTokens,
        },
      })}\n`);
      listeners.get('exit')?.(0, null);
      listeners.get('close')?.(0, null);
      listeners.clear();

      const exitEvent = await waitFor(() => getLaneEvents(lane.id, 200)
        .filter((event) => event.verb === 'runtime_process_exit')[exitCountBefore]);
      expect(exitEvent?.payload).toMatchObject({
        inputTokens,
        cacheReadTokens: contextTokens - inputTokens,
        contextTokens,
      });
      expect(exitEvent?.payload).not.toHaveProperty('toolName', 'Skill');
      expect(contextTokens).toBeLessThan(50_000);

      const synced = await syncOrchestratorControlPlaneState();
      expect(synced.packets[0]?.contextTelemetry).toMatchObject({
        inputTokens,
        cacheReadTokens: contextTokens - inputTokens,
        contextTokens,
        contextDeltaTokens: turnIndex === 0
          ? null
          : contextTokens - contextByTurn[turnIndex - 1]!,
      });
    }
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

  it('treats empty OAuth token fields as no credential and writes no worker snapshot', async () => {
    const emptyConfigDir = path.join(tempRoot, 'operator-empty-credentials');
    const sessionDir = path.join(tempRoot, 'empty-credential-session');
    mkdirSync(emptyConfigDir, { recursive: true });
    writeFileSync(
      path.join(emptyConfigDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '   ' } }),
    );
    const priorConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = emptyConfigDir;

    try {
      const { ensureClaudeCodeWorkerConfigDir } = await import('@/lib/claude-code/codex-subscription-proxy');
      await expect(ensureClaudeCodeWorkerConfigDir(sessionDir, 'native')).rejects.toMatchObject({
        code: 'worker_not_authenticated',
        reason: 'No live Claude OAuth credential was available to seed.',
      });
      expect(existsSync(path.join(sessionDir, 'claude-code-worker-config', '.credentials.json'))).toBe(false);
    } finally {
      if (priorConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = priorConfigDir;
    }
  });

  it.each([
    { source: 'openrouter' as const },
    { source: 'codex-subscription' as const },
  ])('provisions a $source worker config dir while the native CLI reports logged out', async ({ source }) => {
    const emptyConfigDir = path.join(tempRoot, `carrier-no-native-credentials-${source}`);
    const sessionDir = path.join(tempRoot, `carrier-session-${source}`);
    mkdirSync(emptyConfigDir, { recursive: true });
    const priorConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = emptyConfigDir;
    authStatusMock.loggedIn = false;

    try {
      const { ensureClaudeCodeWorkerConfigDir } = await import('@/lib/claude-code/codex-subscription-proxy');
      const configDir = await ensureClaudeCodeWorkerConfigDir(sessionDir, source);
      expect(configDir).toBe(path.join(sessionDir, 'claude-code-worker-config'));
      expect(existsSync(configDir)).toBe(true);
      // The native login probe must not gate a carrier that supplies its own credential.
      expect(existsSync(path.join(configDir, '.credentials.json'))).toBe(false);
    } finally {
      authStatusMock.loggedIn = true;
      if (priorConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = priorConfigDir;
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
