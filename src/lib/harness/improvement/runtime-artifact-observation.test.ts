import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, linkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ImprovementNamespace } from './namespace';
import type { OwnedSessionRecord, OwnedWorkspaceBindingReceipt } from '@/lib/runtimes/shared/owned-session/types';

const controls = vi.hoisted(() => ({ namespace: {} as ImprovementNamespace,
  condition: 'clear', calls: 0, mutate: undefined as undefined | (() => void), locks: [] as string[] }));
vi.mock('./namespace', async importOriginal => ({ ...await importOriginal<typeof import('./namespace')>(),
  requireImprovementNamespace: () => controls.namespace }));
vi.mock('@/lib/runtimes/shared/owned-session/artifact-admission', () => ({
  withOwnedArtifactAdmission: async (_root: string, operation: () => Promise<unknown>) => {
    controls.locks.push('root'); return operation();
  },
}));
vi.mock('@/lib/orchestrator/lifecycle-mutation-lock', () => ({
  withPacketLifecycleSpawnLock: async (_packet: string, operation: () => Promise<unknown>) => {
    controls.locks.push('packet'); return operation();
  },
}));
// Execute the REAL production eight-primitive probe; mock only process inspection.
vi.mock('@/lib/workspace/process-probes', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/workspace/process-probes')>();
  return { ...actual, probeOwnedSessionProcessQuiescence: async (surface: string, workspace: string) => {
    controls.calls += 1;
    if (controls.calls === 2) controls.mutate?.();
    return actual.probeOwnedSessionProcessQuiescence(surface, workspace, {
      run: async (command, args) => {
        if (controls.condition === 'missing' && command === 'pgrep') return { code: 127, stdout: '', stderr: '' };
        if (controls.condition === 'reused' && command === 'ps' && args[0] === '-o') return { code: 0, stdout: '4242 unrelated', stderr: '' };
        if (controls.condition === 'child' && command === 'pgrep' && args[0] === '-g') return { code: 0, stdout: '4243', stderr: '' };
        return { code: command === 'ps' && args[0] === 'axeww' ? 0 : 1, stdout: '', stderr: '' };
      },
      readCwdSnapshot: async () => ({ status: 'ready', rows: [], capturedAt: Date.now() }),
    });
  } };
});
const { registerOwnedSessionLifecycleHandler } = await import('@/lib/runtimes/shared/owned-session-lifecycle');
const { collectRuntimeArtifactObservation } = await import('./runtime-artifact-observation');
const { createExperiment, advanceExperiment } = await import('./engine');
const { createImprovementJournal } = await import('./journal');
const { prepareImprovementPacketBinding, bindImprovementPacketLane } = await import('./launch-guard');
const { digest, artifactInventory } = await import('./validation');

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
function fixture(withInventory = true) {
  controls.condition = 'clear'; controls.calls = 0; controls.mutate = undefined; controls.locks = [];
  const base = mkdtempSync(join(tmpdir(), 'runtime-artifacts-')); roots.push(base);
  const root = join(base, 'namespace'); const repository = join(base, 'repository');
  const runtimeRoot = join(root, 'runtime'); const sessionDir = join(runtimeRoot, 'session');
  for (const path of [root, repository, runtimeRoot, sessionDir]) mkdirSync(path, { mode: 0o700 });
  const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); writeFileSync(join(repository, 'answer.txt'), 'baseline');
  writeFileSync(join(repository, 'keep.txt'), 'unchanged');
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  const identity = (path: string) => { const stat = lstatSync(path); return { path, device: stat.dev, inode: stat.ino }; };
  const stat = lstatSync(root);
  const namespace: ImprovementNamespace = { schema: 'o8/harness-refinement-namespace/v1', id: 'namespace',
    root, repository, experimentId: 'test-artifact', creatorPid: 1, device: stat.dev, inode: stat.ino };
  controls.namespace = namespace; vi.stubEnv('O8_DATA_DIR', root); vi.stubEnv('CORTEX_IDE_DATA_DIR', root);
  let state = createExperiment({ id: namespace.experimentId, repository, baselineRevision: git('rev-parse', 'HEAD'),
    contractDigest: 'a'.repeat(64), verifierDigest: 'b'.repeat(64), permissionsDigest: 'c'.repeat(64), runtime: 'codex',
    model: 'test-model', effort: 'high', provenance: 'native', mode: 'parallel', k: 1, maxStages: 20,
    maxStageWallMs: 1000, maxInputBytes: 100000, baseline: { instructions: 'fixture' },
    tasks: [{ id: 'A', domain: 'code', prompt: 'fixture' }],
    ...(withInventory ? { artifactInventory: { files: ['answer.txt'], maxFileBytes: 1024, maxTotalBytes: 1024 } } : {}) });
  const journal = createImprovementJournal(join(root, 'harness-refinement')); journal.append(state, null);
  state = advanceExperiment(state); journal.append(state, 0);
  const binding = prepareImprovementPacketBinding({ experimentId: state.manifest.id, requestId: state.pending!.id, mountDigest: 'd'.repeat(64) });
  bindImprovementPacketLane(binding.packetId, 'lane');
  const run = { id: 'run', mode: 'launch', outcome: 'finished', finishedAt: '2026-10-20T00:00:00Z', startedAt: '2026-10-19T23:59:00Z',
    pid: 4242, processGroupId: 4242, processMarker: 'unique', commandIdentity: 'worker', spawnState: 'started', detachMode: 'detached',
    childExit: { classification: 'clean-exit', code: 0, signal: null }, prompt: 'fixture', stdoutPath: 'unused', stderrPath: 'unused' } as OwnedSessionRecord['recentRuns'][number];
  const session = { surfaceId: 'artifact-test:session', sessionDir, cwd: repository, repoPath: repository, packetId: binding.packetId,
    laneId: 'lane', model: 'test-model', effort: 'high', recentRuns: [run], runIdentityLedger: { version: 1, totalRuns: 1, complete: true },
    workspaceBinding: { packetId: binding.packetId } } as OwnedSessionRecord;
  const save = () => writeFileSync(join(sessionDir, 'session.json'), JSON.stringify(session), { mode: 0o600 }); save();
  const receipt = { surfaceId: session.surfaceId, runtimeId: 'codex', sessionState: 'active',
    binding: { cwd: repository, packetId: binding.packetId, logicalWorkspaceId: 'fixture-workspace',
      repositoryUuid: null, version: 1, verifiedAt: 'fixture' },
    activeRun: null, retainedRuns: [run], retainedRunsComplete: true, retainedRunTotal: 1 } as OwnedWorkspaceBindingReceipt;
  registerOwnedSessionLifecycleHandler({ runtimeId: 'codex', surfaceIdPrefix: 'artifact-test:', resolveRoot: () => runtimeRoot,
    commandLabel: 'fixture', sessionState: async () => 'active', archiveSession: async () => ({ archived: false, note: 'unused' }),
    getWorkspaceBinding: async () => receipt });
  const prepared = { schema: 'o8/refinement-runtime-observation/v1', trust: 'untrusted-observation', phase: 'prepared',
    experimentId: binding.experimentId, requestId: binding.requestId, packetId: binding.packetId, bindingDigest: digest(binding),
    sessionId: session.surfaceId, runId: run.id, laneId: 'lane', namespaceId: namespace.id, namespaceDigest: digest(namespace),
    storageGeneration: { device: namespace.device, inode: namespace.inode }, source: { head: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') },
    workspace: identity(repository), runtimeRoot: identity(runtimeRoot), sessionDirectory: identity(sessionDir),
    inputPromptDigest: '1'.repeat(64), runtimeArgvDigest: '2'.repeat(64), finalArgvDigest: '3'.repeat(64),
    stdinDigest: '4'.repeat(64), configDigest: '5'.repeat(64),
    attemptPolicy: { mode: 'launch-only', spawn: 'direct', recovery: 'refused', consumption: 'write-once-packet' },
    coverage: { configuration: 'allowlisted-metadata-only', mounts: 'declarative-only', confinement: 'not-attested' },
    mountDigest: 'e'.repeat(64), expectedMountDigest: binding.mountDigest };
  writeFileSync(join(root, `${digest(binding.packetId)}.runtime-prepared.json`), JSON.stringify(prepared), { mode: 0o400 });
  writeFileSync(join(root, `${digest(binding.packetId)}.runtime-started.json`), JSON.stringify({
    schema: 'o8/refinement-runtime-process/v1', trust: 'untrusted-observation', phase: 'started', preparedDigest: digest(prepared),
    sessionId: session.surfaceId, runId: run.id, process: { pid: run.pid, processGroupId: run.processGroupId, processMarker: run.processMarker, commandIdentity: run.commandIdentity },
  }), { mode: 0o400 });
  return { root, repository, session, save, receipt, input: { experimentId: binding.experimentId, requestId: binding.requestId,
    packetId: binding.packetId, surfaceId: session.surfaceId, runId: run.id } };
}

describe('terminal artifact observation is advisory, never authorization', () => {
  it('captures bounded declared bytes through the real collector and real process probe', async () => {
    const f = fixture(); writeFileSync(join(f.repository, 'answer.txt'), 'candidate');
    const result = await collectRuntimeArtifactObservation(f.input);
    expect(result).toMatchObject({ status: 'observed', authorizesExecution: false, scope: 'operator-inventory-only', evaluatorExclusion: 'unverified' });
    expect(controls.locks).toEqual(['root', 'packet']); expect(controls.calls).toBe(3);
    const stored = JSON.parse(readFileSync(join(f.root, `${digest(f.input.packetId)}.runtime-artifacts.json`), 'utf8'));
    expect(Buffer.from(stored.files[0].bytesBase64, 'base64').toString()).toBe('candidate');
    expect(stored.snapshotHash).toBe(digest(stored.files.map(({ path, sha256 }: { path: string; sha256: string }) => ({ path, sha256 }))));
    expect((await collectRuntimeArtifactObservation(f.input)).status).toBe('held');
  });
  it.each(['missing-exit', 'signal', 'nonzero', 'interrupt', 'bridge', 'fallback', 'retry', 'active', 'extra-run', 'read-only-policy'])('holds terminal ambiguity %s', async kind => {
    const f = fixture(); const run = f.session.recentRuns[0]!;
    if (kind === 'missing-exit') delete run.childExit;
    if (kind === 'signal') run.childExit!.signal = 'SIGTERM';
    if (kind === 'nonzero') run.childExit!.code = 1;
    if (kind === 'interrupt') run.interruptRequestedAt = 'now';
    if (kind === 'bridge') run.detachMode = 'bridge';
    if (kind === 'fallback') run.modelFallback = { fromModel: 'a', toModel: 'b', notice: 'fallback' };
    if (kind === 'retry') f.session.autoRetry = true;
    if (kind === 'active') f.session.activeRun = run;
    if (kind === 'extra-run') f.session.recentRuns.push({ ...run, id: 'second' });
    if (kind === 'read-only-policy') f.session.executionPolicy = { mode: 'single-attempt' } as OwnedSessionRecord['executionPolicy'];
    f.save(); expect((await collectRuntimeArtifactObservation(f.input)).status).toBe('held');
  });
  it('holds a lifecycle identity that differs from the durable run', async () => {
    const f = fixture(); f.receipt.retainedRuns = [{ ...f.receipt.retainedRuns[0]!, pid: 9999 }];
    expect((await collectRuntimeArtifactObservation(f.input)).status).toBe('held');
  });
  it.each(['child', 'reused', 'missing'])('holds %s process evidence', async condition => {
    const f = fixture(); controls.condition = condition;
    expect((await collectRuntimeArtifactObservation(f.input)).status).toBe('held'); expect(controls.calls).toBe(1);
  });
  it('holds legacy manifests without an artifact scope without reading artifact bytes', async () => {
    const f = fixture(false);
    expect(await collectRuntimeArtifactObservation(f.input)).toMatchObject({ status: 'held', reason: 'artifact_scope_unavailable' });
  });
  it.each(['ownership', 'artifact', 'source'])('holds a %s change during capture and refuses retry', async kind => {
    const f = fixture(); controls.mutate = () => {
      if (kind === 'ownership') { f.session.packetId = 'another'; f.save(); }
      else writeFileSync(join(f.repository, kind === 'artifact' ? 'answer.txt' : 'stray.txt'), 'raced');
    };
    expect((await collectRuntimeArtifactObservation(f.input)).status).toBe('held');
    expect((await collectRuntimeArtifactObservation(f.input)).status).toBe('held');
  });
  it.each(['stray.txt', '.gitignore', 'keep.txt'])('does not hide outside-inventory path %s', async path => {
    const f = fixture(); writeFileSync(join(f.repository, path), 'damage');
    expect((await collectRuntimeArtifactObservation(f.input)).status).toBe('held');
  });
  it.each(['--assume-unchanged', '--skip-worktree'])('holds hidden index flags %s', async flag => {
    const f = fixture(); execFileSync('git', ['-C', f.repository, 'update-index', flag, 'answer.txt']);
    writeFileSync(join(f.repository, 'answer.txt'), 'hidden edit');
    expect((await collectRuntimeArtifactObservation(f.input)).status).toBe('held');
  });
  it('does not hide ignored files', async () => {
    const f = fixture(); writeFileSync(join(f.repository, '.git', 'info', 'exclude'), 'hidden.txt\n');
    writeFileSync(join(f.repository, 'hidden.txt'), 'do not read');
    expect((await collectRuntimeArtifactObservation(f.input)).status).toBe('held');
  });
  it.each(['symlink', 'hardlink', 'oversize', 'deleted'])('holds %s artifacts', async kind => {
    const f = fixture(); const target = join(f.repository, 'answer.txt');
    if (kind === 'oversize') writeFileSync(target, 'x'.repeat(1025));
    else { rmSync(target); if (kind === 'symlink') symlinkSync('/etc/passwd', target);
      if (kind === 'hardlink') { const other = join(f.root, 'other'); writeFileSync(other, 'bytes'); linkSync(other, target); } }
    expect((await collectRuntimeArtifactObservation(f.input)).status).toBe('held');
  });
  it('holds changed storage ownership permissions', async () => {
    const f = fixture(); chmodSync(f.root, 0o777);
    expect((await collectRuntimeArtifactObservation(f.input)).status).toBe('held');
  });
  it.each(['../escape', 'a/../escape', '.env', 'evaluator/data.txt', 'secrets/key.txt', 'a//b', '/absolute'])('rejects scope %s', path => {
    expect(() => artifactInventory({ files: [path], maxFileBytes: 100, maxTotalBytes: 100 })).toThrow();
  });
});
