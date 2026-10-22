import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { PacketStorageAdmissionCoordinator } from '@/lib/orchestrator/storage-admission';
import type { ImprovementPacketBinding, ImprovementPacketLaunchInput, ImprovementPacketLaunchGrant } from '@/lib/harness/improvement/launch-guard';
import type { ImprovementManifest } from '@/lib/harness/improvement/types';
import { advanceExperiment, createExperiment, settleExperiment } from '@/lib/harness/improvement/engine';
import { createImprovementJournal } from '@/lib/harness/improvement/journal';
import { digest } from '@/lib/harness/improvement/validation';

const h = vi.hoisted(() => ({
  launch: vi.fn(async () => ({ ok: true, surfaceId: 'fixture-only', note: 'fixture provider', worktree: null })),
  recover: vi.fn<(...args: unknown[]) => Promise<null | { outcome: string; surfaceId: string }>>(async () => null), preflight: vi.fn(async () => {}),
  rebase: vi.fn(async (_path: string, _options: unknown) => {}),
}));
vi.mock('@/lib/runtime/actions', () => ({ launchRuntimeSurface: h.launch }));
vi.mock('@/lib/runtimes/shared/owned-session-index', () => ({ findOwnedLaunchByMutationId: h.recover }));
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({ assertRuntimeDispatchable: h.preflight }));
vi.mock('@/lib/runtimes/shared/cli-locate', () => ({ scanForBinary: vi.fn(() => null) }));
vi.mock('@/lib/orchestrator/capacity-snapshots', () => ({ capturePacketCapacitySnapshot: vi.fn(async () => {}) }));
vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: vi.fn(async () => {}) }));
vi.mock('@/lib/worktree', () => ({
  getWorktreeManager: () => ({ rebaseOntoMain: h.rebase }),
  WorktreeFetchUnreachableError: class extends Error {},
}));
vi.mock('@/lib/runtime/fetch-unreachable-recovery', () => ({
  fetchUnreachableCooldownRetrySeconds: () => null, recordFetchUnreachableRecoverySuccess: () => {},
}));

const root = mkdtempSync(join(realpathSync(tmpdir()), 'o8-refinement-launch-guard-'));
const dataDir = join(root, 'data'); mkdirSync(dataDir, { mode: 0o700 });
const priorData = process.env.CORTEX_IDE_DATA_DIR; const priorO8Data = process.env.O8_DATA_DIR;
process.env.O8_DATA_DIR = dataDir; process.env.CORTEX_IDE_DATA_DIR = dataDir;
const guard = await import('@/lib/harness/improvement/launch-guard');
const { launchSession } = await import('@/lib/lane/commands-launch');
const { createLane, updateLane, getLane } = await import('@/lib/lane/registry');
const { launchPacketWithStorageAdmission } = await import('@/lib/orchestrator/dispatch-packet-launch');
const { resolveWorkerRouting } = await import('@/lib/agents/routing');
const { closeDb } = await import('@/lib/db');
const journal = createImprovementJournal(join(dataDir, 'harness-refinement'));

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
}
function fixture(id: string, provenance: 'fixture' | 'native' = 'native') {
  const repo = join(root, id); mkdirSync(repo);
  git(repo, ['init', '-q', '--initial-branch=main']);
  writeFileSync(join(repo, 'source.txt'), 'frozen source\n');
  git(repo, ['add', 'source.txt']);
  git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const manifest: ImprovementManifest = {
    id, repository: realpathSync(repo), baselineRevision: git(repo, ['rev-parse', 'HEAD']),
    contractDigest: 'a'.repeat(64), verifierDigest: 'b'.repeat(64), permissionsDigest: 'c'.repeat(64),
    runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high', provenance,
    mode: 'parallel', k: 1, maxStages: 9, maxStageWallMs: 1000, maxInputBytes: 100000,
    baseline: { instructions: 'Only edit disposable fixtures. Preserve authorization.' },
    tasks: [{ id: 'A', domain: 'code', prompt: 'Modify the disposable fixture.' }],
  };
  const initial = journal.append(createExperiment(manifest), null);
  const state = journal.append(advanceExperiment(initial), initial.revision);
  return { repo, manifest, state };
}
function bound(id: string) {
  const result = fixture(id);
  const binding = guard.prepareImprovementPacketBinding({ experimentId: id, requestId: result.state.pending!.id, mountDigest: 'd'.repeat(64) });
  return { ...result, binding };
}
function launchInput(binding: ImprovementPacketBinding): ImprovementPacketLaunchInput {
  return { packetId: binding.packetId, repository: binding.manifest.repository,
    runtime: binding.manifest.runtime, model: binding.manifest.model, effort: binding.manifest.effort, boundary: 'dispatch' };
}
function grantPath(binding: ImprovementPacketBinding): string {
  return join(dataDir, 'harness-refinement-packets', `${digest(binding.packetId)}.grant.json`);
}
function grant(binding: ImprovementPacketBinding): ImprovementPacketLaunchGrant {
  return { schema: 'o8/harness-refinement-launch-grant/v1', packetId: binding.packetId,
    bindingDigest: digest(binding), manifestDigest: binding.manifestDigest, requestDigest: binding.requestDigest,
    permissionsDigest: binding.manifest.permissionsDigest, verifierDigest: binding.manifest.verifierDigest,
    mountDigest: binding.mountDigest, authorizationId: 'untrusted-fixture-assertion', issuer: 'operator',
    proof: 'not-a-trusted-proof', expiresAt: Date.now() + 60000 };
}
function packet(binding: ImprovementPacketBinding): OrchestratorPacket {
  return { id: binding.packetId, referenceLabel: 'refinement', title: 'Isolated refinement fixture', summary: 'fixture',
    workspaceTargetPath: binding.manifest.repository, branchTarget: 'issue/refinement', runtime: 'codex',
    dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued', releaseState: 'pending', status: 'queued' };
}
function admission() {
  const reserve = vi.fn(async () => { throw new Error('Storage admission must not be reached.'); });
  const coordinator = { reserveForLaunch: reserve } as unknown as PacketStorageAdmissionCoordinator;
  return { reserve, coordinator };
}

beforeEach(() => { vi.clearAllMocks(); h.recover.mockImplementation(async () => null); h.rebase.mockImplementation(async () => {}); });
afterAll(() => {
  closeDb(); vi.unstubAllGlobals();
  if (priorData === undefined) delete process.env.CORTEX_IDE_DATA_DIR; else process.env.CORTEX_IDE_DATA_DIR = priorData;
  if (priorO8Data === undefined) delete process.env.O8_DATA_DIR; else process.env.O8_DATA_DIR = priorO8Data;
  rmSync(root, { recursive: true, force: true });
});

describe.sequential('durable refinement packet preparation and real launch guards (no live execution evidence)', () => {
  it('does not create app state or alter ordinary packets when the registry is absent', () => {
    const absent = join(root, 'absent-data'); process.env.O8_DATA_DIR = absent;
    try {
      guard.assertImprovementPacketLaunch({ packetId: 'ordinary-packet', laneId: 'ordinary-lane',
        repository: null, runtime: 'codex', model: null, effort: null, boundary: 'lane-recovery' });
      expect(existsSync(absent)).toBe(false);
      expect(() => guard.assertImprovementPacketLaunch({ packetId: guard.improvementPacketId('missing', 'missing'),
        repository: null, runtime: 'codex', model: null, effort: null, boundary: 'dispatch' }))
        .toThrow('no durable binding');
      expect(existsSync(absent)).toBe(false);
    } finally { process.env.O8_DATA_DIR = dataDir; }
  });

  it('persists exact immutable bindings across reload and does not turn preparation into consent', () => {
    const { binding } = bound('immutable');
    const file = join(dataDir, 'harness-refinement-packets', `${digest(binding.packetId)}.binding.json`);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(binding);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dataDir, 'harness-refinement-packets')).mode & 0o777).toBe(0o700);
    closeDb();
    expect(() => guard.assertImprovementPacketLaunch(launchInput(binding))).toThrow('Separate explicit trusted launch authorization');
    expect(guard.prepareImprovementPacketBinding({ experimentId: 'immutable', requestId: binding.requestId,
      mountDigest: binding.mountDigest })).toEqual(binding);
    expect(() => guard.prepareImprovementPacketBinding({ experimentId: 'immutable', requestId: binding.requestId,
      mountDigest: 'e'.repeat(64) })).toThrow('already differs');
  });

  it('cannot prepare fixture output as native packet evidence', () => {
    const { state } = fixture('fixture-only', 'fixture');
    expect(() => guard.prepareImprovementPacketBinding({ experimentId: 'fixture-only', requestId: state.pending!.id,
      mountDigest: 'd'.repeat(64) })).toThrow('native execution binding');
  });

  it.each(['model', 'runtime', 'effort', 'executionCarrier', 'claudeCodeCarrier'] as const)('rejects changed effective %s', (field) => {
    const { binding } = bound(`pin-${field}`);
    expect(() => guard.assertImprovementPacketLaunch({ ...launchInput(binding), [field]: 'changed' }))
      .toThrow('differs from the immutable manifest');
  });

  it('rejects dirty source, changed source SHA and unrelated checkouts', () => {
    const { binding, repo } = bound('source-drift');
    writeFileSync(join(repo, 'untracked.txt'), 'not part of the frozen revision');
    expect(() => guard.assertImprovementPacketLaunch(launchInput(binding))).toThrow('clean immutable source');
    rmSync(join(repo, 'untracked.txt'));
    git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'drift']);
    expect(() => guard.assertImprovementPacketLaunch(launchInput(binding))).toThrow('source revision');
    const other = bound('other-repository');
    expect(() => guard.assertImprovementPacketLaunch({ ...launchInput(binding), repository: other.repo }))
      .toThrow('differs from the immutable manifest');
  });

  it('refuses ignored source additions and ignores ambient Git redirect variables', () => {
    const { binding, repo } = bound('ignored-source');
    writeFileSync(join(repo, '.git', 'info', 'exclude'), 'hidden-input.txt\n');
    writeFileSync(join(repo, 'hidden-input.txt'), 'unfrozen runtime input');
    expect(git(repo, ['status', '--porcelain'])).toBe('');
    expect(() => guard.assertImprovementPacketLaunch(launchInput(binding))).toThrow('clean immutable source');
    const other = bound('git-environment-target');
    const previousDir = process.env.GIT_DIR; const previousTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = join(other.repo, '.git'); process.env.GIT_WORK_TREE = other.repo;
    try {
      expect(() => guard.assertImprovementPacketLaunch(launchInput(binding))).toThrow('clean immutable source');
    } finally {
      if (previousDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previousDir;
      if (previousTree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = previousTree;
    }
  });

  it('refuses repository-configured filters before any helper can be invoked', () => {
    const { binding, repo } = bound('configured-filter');
    git(repo, ['config', 'filter.untrusted.clean', 'this-command-must-never-run']);
    expect(() => guard.assertImprovementPacketLaunch(launchInput(binding))).toThrow('separately verified source inspection');
  });

  it('requires the launch source to belong to the pinned repository, not just have an identical SHA', () => {
    const { binding, repo } = bound('source-repository-binding'); const clone = join(root, 'unrelated-identical-clone');
    git(repo, ['clone', '-q', '--no-hardlinks', repo, clone]);
    expect(git(clone, ['rev-parse', 'HEAD'])).toBe(binding.manifest.baselineRevision);
    expect(() => guard.assertImprovementPacketLaunch({ ...launchInput(binding), sourcePath: clone }))
      .toThrow('not a worktree of the pinned repository');
  });

  it.each(['permissionsDigest', 'verifierDigest', 'mountDigest'] as const)('requires grant %s equality but never trusts a forged matching grant', (field) => {
    const { binding } = bound(`grant-${field}`);
    writeFileSync(grantPath(binding), JSON.stringify({ ...grant(binding), [field]: 'f'.repeat(64) }), { mode: 0o600 });
    expect(() => guard.assertImprovementPacketLaunch(launchInput(binding))).toThrow('grant does not match');
    writeFileSync(grantPath(binding), JSON.stringify(grant(binding)));
    expect(() => guard.assertImprovementPacketLaunch(launchInput(binding))).toThrow('no consent verifier or verified isolated carrier');
  });

  it('rejects stale reservations after a durable failed settlement', () => {
    const { state, binding } = bound('stale-reservation');
    const settled = settleExperiment(state, { requestId: state.pending!.id, requestDigest: digest(state.pending),
      status: 'failed', provenance: 'native', runtime: 'codex', model: binding.manifest.model, effort: 'high',
      usage: { attempts: 1, inputTokens: null, outputTokens: null, actualUsd: null, estimatedUsd: null,
        wallMs: 1, humanMs: null, billing: 'unknown' } });
    journal.append(settled, state.revision);
    expect(() => guard.assertImprovementPacketLaunch(launchInput(binding))).toThrow('exact durable pending execution');
  });

  it('never treats request claims or an actor label as authorization', () => {
    const { binding } = bound('body-claims');
    const claims = { ...launchInput(binding), approved: true, actor: 'user', sandboxVerified: true };
    expect(() => guard.assertImprovementPacketLaunch(claims)).toThrow('trusted launch authorization');
  });

  it('rejects unsafe registry permissions, symlinks and hard links', () => {
    const { binding } = bound('unsafe-storage');
    const file = join(dataDir, 'harness-refinement-packets', `${digest(binding.packetId)}.binding.json`);
    chmodSync(file, 0o644);
    expect(() => guard.assertImprovementPacketLaunch(launchInput(binding))).toThrow('private');
    chmodSync(file, 0o600);
    const copy = join(root, 'hard-link'); linkSync(file, copy);
    expect(() => guard.assertImprovementPacketLaunch(launchInput(binding))).toThrow('Unsafe');
    rmSync(copy);
    const bytes = readFileSync(file); rmSync(file); writeFileSync(copy, bytes, { mode: 0o600 }); symlinkSync(copy, file);
    expect(() => guard.assertImprovementPacketLaunch(launchInput(binding))).toThrow();
    rmSync(file); writeFileSync(file, bytes, { mode: 0o600 });
  });

  it('checks resolved dispatch pins and consent before storage or provider preflight, including recovery', async () => {
    const { binding } = bound('dispatch-held'); const storage = admission();
    const workerRouting = resolveWorkerRouting({ requestedRuntime: 'codex', requestedModel: binding.manifest.model,
      requestedEffort: 'high', source: 'packet-dispatch' });
    for (const status of ['queued', 'recovering'] as const) {
      const current = { ...packet(binding), status };
      await expect(launchPacketWithStorageAdmission({ packet: current, allPackets: [current], workerRouting,
        storageAdmission: storage.coordinator })).rejects.toThrow('Separate explicit trusted launch authorization');
    }
    const override = { ...packet(binding), claudeCodeModel: 'changed-effective-override' };
    await expect(launchPacketWithStorageAdmission({ packet: override, allPackets: [override], workerRouting,
      storageAdmission: storage.coordinator })).rejects.toThrow('differs from the immutable manifest');
    expect(storage.reserve).not.toHaveBeenCalled(); expect(h.preflight).not.toHaveBeenCalled(); expect(h.launch).not.toHaveBeenCalled();
  });

  it('holds direct lane recovery and retains ownership when packet metadata is removed', async () => {
    const { binding, repo } = bound('lane-recovery');
    const lane = createLane({ repoPath: repo, branch: 'issue/recovery', runtime: 'codex', packetId: binding.packetId });
    guard.bindImprovementPacketLane(binding.packetId, lane.id);
    const command = { verb: 'launch_session' as const, laneId: lane.id, prompt: 'fixture',
      model: binding.manifest.model, effort: 'high' as const, clientMutationId: 'pending-owned-recovery' };
    expect(await launchSession(command, 'user')).toMatchObject({ ok: false, note: expect.stringContaining('trusted launch authorization') });
    updateLane(lane.id, { packetId: null }, 'system');
    closeDb();
    expect(await launchSession(command, 'user')).toMatchObject({ ok: false, note: expect.stringContaining('ownership was removed') });
    expect(h.recover).not.toHaveBeenCalled(); expect(h.rebase).not.toHaveBeenCalled(); expect(h.launch).not.toHaveBeenCalled();
  });

  it('refuses reserved packet lanes with a missing durable lane association', async () => {
    const { binding, repo } = bound('missing-lane-index');
    const lane = createLane({ repoPath: repo, branch: 'issue/missing-index', runtime: 'codex', packetId: binding.packetId });
    expect(await launchSession({ verb: 'launch_session', laneId: lane.id, prompt: 'fixture',
      model: binding.manifest.model, effort: 'high' }, 'user'))
      .toMatchObject({ ok: false, note: expect.stringContaining('no durable packet association') });
    expect(h.recover).not.toHaveBeenCalled(); expect(h.launch).not.toHaveBeenCalled();
  });

  it('rechecks durable ownership after an asynchronous owned-session recovery lookup', async () => {
    const { binding, repo } = bound('recovery-race');
    const lane = createLane({ repoPath: repo, branch: 'issue/recovery-race', runtime: 'codex' });
    h.recover.mockImplementationOnce(async () => {
      guard.bindImprovementPacketLane(binding.packetId, lane.id);
      updateLane(lane.id, { packetId: binding.packetId }, 'system');
      return { outcome: 'completed', surfaceId: 'never-attach-this-fixture' };
    });
    expect(await launchSession({ verb: 'launch_session', laneId: lane.id, prompt: 'fixture',
      model: binding.manifest.model, effort: 'high', clientMutationId: 'recovery-race' }, 'user'))
      .toMatchObject({ ok: false, note: expect.stringContaining('trusted launch authorization') });
    expect(h.recover).toHaveBeenCalledOnce(); expect(h.launch).not.toHaveBeenCalled();
    expect(getLane(lane.id)?.sessionKey).toBeNull();
  });

  it('rechecks registry and the actual post-refresh SHA immediately before the real runtime call seam', async () => {
    const { binding, repo } = bound('post-rebase'); const worktree = join(root, 'post-rebase-worktree');
    git(repo, ['worktree', 'add', '-q', '-b', 'issue/post-rebase', worktree]);
    const lane = createLane({ repoPath: repo, worktreePath: worktree, branch: 'issue/post-rebase', runtime: 'codex' });
    // Initially ordinary: the real early check succeeds. A competing preparer binds
    // the lane during refresh, so only the production post-await guard can catch it.
    h.rebase.mockImplementationOnce(async () => {
      guard.bindImprovementPacketLane(binding.packetId, lane.id);
      updateLane(lane.id, { packetId: binding.packetId }, 'system');
      git(worktree, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'refreshed base drift']);
    });
    expect(await launchSession({ verb: 'launch_session', laneId: lane.id, prompt: 'fixture',
      model: binding.manifest.model, effort: 'high' }, 'orchestrator'))
      .toMatchObject({ ok: false, note: expect.stringContaining('Post-refresh checkout HEAD') });
    expect(h.rebase).toHaveBeenCalledOnce(); expect(h.launch).not.toHaveBeenCalled();
    expect(getLane(lane.id)?.sessionKey).toBeNull();
  });

  it('still launches an ordinary lane through its original runtime seam', async () => {
    const { repo } = fixture('ordinary-lane');
    const lane = createLane({ repoPath: repo, branch: 'issue/ordinary', runtime: 'codex', packetId: 'ordinary-packet' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    expect(await launchSession({ verb: 'launch_session', laneId: lane.id, prompt: 'ordinary fixture' }, 'system'))
      .toMatchObject({ ok: true });
    expect(h.launch).toHaveBeenCalledOnce();
  });
});
