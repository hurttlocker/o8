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
const authProbeEnvMock = vi.hoisted(() => vi.fn());
const keychainLookupMock = vi.hoisted(() => vi.fn());
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
        keychainLookupMock();
        const error = Object.assign(new Error('test keychain item unavailable'), { code: 44 });
        callback(error, '', '');
        return {};
      }
      if (args[0] === 'auth' && args[1] === 'status') {
        authProbeEnvMock((options as { env?: NodeJS.ProcessEnv }).env);
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
  let dataDir: string;
  let ownedRoot: string;
  const listeners = new Map<string, (...args: unknown[]) => void>();

  beforeAll(() => {
    tempRoot = mkdtempSync(path.join(os.homedir(), '.tmp-o8-claude-skill-isolation-'));
    fakeHome = path.join(tempRoot, 'operator-home');
    repoPath = path.join(fakeHome, 'repo');
    dataDir = path.join(tempRoot, 'data');
    ownedRoot = path.join(dataDir, 'owned');
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
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_SECURESTORAGE_CONFIG_DIR',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'O8_MASTER_KEY',
    ]) {
      priorEnv[key] = process.env[key];
    }
    for (const key of ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
      delete process.env[key];
    }
    process.env.HOME = fakeHome;
    process.env.O8_DATA_DIR = dataDir;
    process.env.CORTEX_IDE_DATA_DIR = dataDir;
    process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT = ownedRoot;
    process.env.O8_CLAUDE_CODE_BIN = process.execPath;
    process.env.O8_MASTER_KEY = Buffer.alloc(32, 7).toString('base64url');

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
      launchContext: {
        source: 'agent',
        presentation: 'split',
        repoContext: 'registered',
        ...(process.platform === 'darwin' ? { workMode: 'read-only' as const } : {}),
        caller: 'claude-code-worker-skill-isolation-real-path',
      },
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
    const { saveNativeWorkerToken } = await import('@/lib/claude-code/worker-token');
    const dedicatedToken = `sk-ant-oat01-${'synthetic'.repeat(12)}`;
    if (process.platform === 'darwin') await saveNativeWorkerToken(dedicatedToken);

    for (const [turnIndex, contextTokens] of contextByTurn.entries()) {
      delete process.env.CLAUDE_CONFIG_DIR;
      delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
      const selectedStore = path.join(fakeHome, '.claude');
      mkdirSync(selectedStore, { recursive: true });
      const sourceCredentialsPath = path.join(selectedStore, '.credentials.json');
      writeFileSync(sourceCredentialsPath, JSON.stringify({
        claudeAiOauth: { accessToken: `synthetic-access-${turnIndex}`, refreshToken: `synthetic-refresh-${turnIndex}` },
      }));
      const inputTokens = 203 + turnIndex;
      const providerFailed = turnIndex === contextByTurn.length - 1;
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
      const scratchDir = path.join(configDir, 'tmp');
      expect(options.env.CLAUDE_CODE_TMPDIR).toBe(scratchDir);
      expect(statSync(scratchDir).mode & 0o777).toBe(0o700);
      expect(existsSync(path.join(configDir, 'skills'))).toBe(false);
      expect(args).toContain('--disable-slash-commands');
      expect(spawnMock.mock.results[spawnCallIndex]?.value.stdin.end).toHaveBeenCalledWith(
        expect.stringContaining('Claude Code skills are unavailable in this dispatched worker.'),
        'utf8',
      );

      // Mac workers receive only the inference token, never a refresh-store copy.
      const seededCredentialsPath = path.join(configDir, '.credentials.json');
      if (process.platform === 'darwin') {
        expect(options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(configDir);
        expect(options.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(dedicatedToken);
        expect(authProbeEnvMock).not.toHaveBeenCalled();
        expect(keychainLookupMock).not.toHaveBeenCalled();
        expect(existsSync(seededCredentialsPath)).toBe(false);
      } else {
        expect(readFileSync(seededCredentialsPath, 'utf8')).toBe(readFileSync(sourceCredentialsPath, 'utf8'));
        expect(statSync(seededCredentialsPath).mode & 0o777).toBe(0o600);
      }

      const surfaceId = getLane(lane.id)?.sessionKey;
      if (!surfaceId) throw new Error(`Turn ${turnIndex + 1} did not attach a session.`);
      const sessionDir = path.join(ownedRoot, surfaceId.replace('claude-code-owned:', ''));
      if (process.platform === 'darwin') {
        // The real macOS policy must re-open only this prepared config subtree
        // after the relocated data-root denial. Never print credential content.
        const { SANDBOX_EXEC_PATH } = await import('@/lib/runtimes/shared/owned-session/sandbox');
        const sandboxIndex = args.indexOf(SANDBOX_EXEC_PATH);
        expect(sandboxIndex).toBeGreaterThan(-1);
        const profilePath = args[sandboxIndex + 2]!;
        const profile = readFileSync(profilePath, 'utf8');
        expect(profile.lastIndexOf(`(subpath "${configDir}")`))
          .toBeGreaterThan(profile.indexOf(`(subpath "${dataDir}")`));
        expect(existsSync(path.join(configDir, 'hooks'))).toBe(false);
        expect(() => execFileSync(SANDBOX_EXEC_PATH, [
          '-f', profilePath, process.execPath, '-e',
          'require("node:fs").openSync(process.argv[1], "r+")', sourceCredentialsPath,
        ], { stdio: 'ignore' })).toThrow();
        expect(profile).not.toContain('.oauth_refresh.lock');
        expect(() => execFileSync(SANDBOX_EXEC_PATH, [
          '-f', profilePath, '/bin/cat', path.join(dataDir, 'native-worker-token.json'),
        ], { stdio: 'ignore' })).toThrow();
        expect(profile).not.toContain('login.keychain-db');
        const compactedState = path.join(configDir, 'projects', 'repo', `compact-${turnIndex}.json`);
        execFileSync(SANDBOX_EXEC_PATH, [
          '-f', profilePath, '/bin/sh', '-c',
          `mkdir -p ${JSON.stringify(path.dirname(compactedState))} && printf '{}' > ${JSON.stringify(compactedState)}`,
        ], { stdio: 'ignore' });
        expect(existsSync(compactedState)).toBe(true);

        expect(() => execFileSync(SANDBOX_EXEC_PATH, [
          '-f', profilePath, '/bin/cat', path.join(sessionDir, 'session.json'),
        ], { stdio: 'ignore' })).toThrow();
        expect(() => execFileSync(SANDBOX_EXEC_PATH, [
          '-f', profilePath, '/bin/sh', '-c',
          `printf changed > ${JSON.stringify(path.join(worktreePath, 'sandbox-write.txt'))}`,
        ], { stdio: 'ignore' })).toThrow();
      }
      const session = JSON.parse(readFileSync(path.join(sessionDir, 'session.json'), 'utf8')) as {
        recentRuns: Array<{ stdoutPath: string }>;
      };
      expect(JSON.stringify(session)).not.toContain(dedicatedToken);
      const exitCountBefore = getLaneEvents(lane.id, 200)
        .filter((event) => event.verb === 'runtime_process_exit').length;
      const streamedMessages = [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Inspecting the source.' }] } },
        { type: 'stream_event', event: { type: 'message_stop' } },
        { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 58_671 } },
        { type: 'stream_event', event: { type: 'message_stop' } },
      ].map((event) => JSON.stringify(event)).join('\n');
      writeFileSync(session.recentRuns[0]!.stdoutPath, `${streamedMessages}\n${JSON.stringify({
        type: 'result',
        subtype: 'success',
        ...(providerFailed ? { is_error: true } : {}),
        result: providerFailed ? 'Not logged in' : 'done',
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
        ...(providerFailed ? {
          exitCode: 0,
          classification: 'clean-exit',
          runtimeOutcome: 'failed',
          completedTurn: false,
          providerFailure: { subtype: 'success', message: 'Not logged in' },
        } : {}),
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
      if (providerFailed) {
        expect(synced.packets[0]?.status).toBe('failed');
        expect(synced.packets[0]?.status).not.toBe('awaiting_review');
        expect(synced.packets[0]?.releaseState).not.toBe('released');
      }
    }
    rmSync(path.join(dataDir, 'native-worker-token.json'), { force: true });
  }, 30_000);

  it('fails the persisted dispatch path before spawn when no saved credential is available', async () => {
    const noCredsHome = path.join(tempRoot, 'operator-home-no-creds');
    mkdirSync(path.join(noCredsHome, '.claude'), { recursive: true });
    const noCredsRepoPath = path.join(noCredsHome, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', noCredsRepoPath]);

    const { writeClaudeCodeWorkerProfile } = await import('@/lib/claude-code/worker-profile');
    const { buildPacketPrompt } = await import('@/lib/orchestrator/packet-prompt');
    const { createLane, getLane, getLaneEvents } = await import('@/lib/lane/registry');
    const { dispatch: dispatchLaneCommand } = await import('@/lib/lane/commands');
    const {
      readOrchestratorControlPlaneState,
      writeOrchestratorControlPlaneState,
    } = await import('@/lib/orchestrator/control-plane');

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
      launchContext: {
        source: 'agent',
        presentation: 'split',
        repoContext: 'registered',
        workMode: 'edit',
        caller: 'claude-code-worker-skill-isolation-real-path',
      },
    } as OrchestratorPacket;
    const current = readOrchestratorControlPlaneState();
    writeOrchestratorControlPlaneState({
      ...current,
      missionId: current.missionId ?? 'mission-claude-worker-skill-isolation-real-path',
      repoPath: current.repoPath ?? noCredsRepoPath,
      runtime: current.runtime ?? 'claude-code',
      packets: [...current.packets.filter((entry) => entry.id !== packetId), packet],
    });
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

  it.skipIf(process.platform === 'darwin')('rejects launch when the native CLI reports the selected store is logged out', async () => {
    const { ensureClaudeCodeWorkerConfigDir } = await import('@/lib/claude-code/codex-subscription-proxy');
    authStatusMock.loggedIn = false;
    try {
      await expect(ensureClaudeCodeWorkerConfigDir(
        path.join(tempRoot, 'rejected-credential-session'),
        'native',
      )).rejects.toMatchObject({
        code: 'worker_not_authenticated',
        reason: 'The native CLI reports no login in the selected credential store.',
      });
    } finally {
      authStatusMock.loggedIn = true;
    }
  });

  it.skipIf(process.platform !== 'darwin')('refuses the operator login when a dedicated token is missing', async () => {
    const { ensureClaudeCodeWorkerConfigDir } = await import('@/lib/claude-code/codex-subscription-proxy');
    await expect(ensureClaudeCodeWorkerConfigDir(path.join(tempRoot, 'token-unavailable'), 'native'))
      .rejects.toMatchObject({ code: 'worker_not_authenticated' });
    expect(keychainLookupMock).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== 'darwin')('removes only an obsolete worker snapshot before reusing its config', async () => {
    const { ensureClaudeCodeWorkerConfigDir } = await import('@/lib/claude-code/codex-subscription-proxy');
    const sessionDir = path.join(tempRoot, 'obsolete-snapshot');
    const configDir = path.join(sessionDir, 'claude-code-worker-config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, '.credentials.json'), 'synthetic-obsolete-snapshot');
    const sourcePath = path.join(fakeHome, '.claude', '.credentials.json');
    const before = readFileSync(sourcePath, 'utf8');
    await expect(ensureClaudeCodeWorkerConfigDir(sessionDir, 'native')).rejects.toMatchObject({ code: 'worker_not_authenticated' });
    expect(existsSync(path.join(configDir, '.credentials.json'))).toBe(false);
    expect(readFileSync(sourcePath, 'utf8')).toBe(before);
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
        reason: process.platform === 'darwin'
          ? 'No dedicated worker credential is configured. Run `npm run worker:login` from the application source checkout to connect a dedicated worker token.'
          : 'No live Claude OAuth credential was available to seed.',
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
