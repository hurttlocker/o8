import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { advanceExperiment, createExperiment } from '@/lib/harness/improvement/engine';
import { createImprovementJournal } from '@/lib/harness/improvement/journal';
import { createImprovementNamespace } from '@/lib/harness/improvement/namespace';
import { bindImprovementPacketLane, prepareImprovementPacketBinding } from '@/lib/harness/improvement/launch-guard';
import { digest } from '@/lib/harness/improvement/validation';
import type { ImprovementManifest } from '@/lib/harness/improvement/types';
import type { OwnedRuntimeAdapter, OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';
import type { OwnedSessionIo } from '@/lib/runtimes/shared/owned-session/session-io';

const h = vi.hoisted(() => ({ spawn: vi.fn(), bridge: vi.fn(), ready: vi.fn(), prepare: vi.fn(), sync: vi.fn(), grant: vi.fn() }));
// Only fake-process observation fixtures bypass the real, universally-held grant seam.
vi.mock('@/lib/harness/improvement/launch-guard', async original => ({
  ...await original<typeof import('@/lib/harness/improvement/launch-guard')>(), assertImprovementPacketLaunch: h.grant,
}));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: h.spawn }));
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>(); h.sync.mockImplementation(actual.fsyncSync);
  return { ...actual, fsyncSync: h.sync };
});
vi.mock('@/lib/runtime/pty-bridge', () => ({ spawnBridgeTerminalSession: h.bridge }));
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({ ensureDispatchBackendReady: h.ready }));
vi.mock('@/lib/runtimes/shared/cli-resolver', () => ({ resolveCli: async () => ({ path: '/fake/codex' }), CliNotFoundError: class extends Error {} }));
vi.mock('@/lib/auth/worker-token', () => ({ getOrCreateLocalWorkerToken: () => 'secret-token' }));
vi.mock('@/lib/auth/packet-worker-token', () => ({ mintPacketWorkerToken: () => 'secret-token', bindPacketWorkerTokenProcess: vi.fn() }));
vi.mock('@/lib/runtimes/shared/owned-session/worker-mcp-config', () => ({ prepareOwnedWorkerMcpConfig: async () => ({ servers: [], sandboxReadPaths: [] }) }));
vi.mock('@/lib/runtimes/shared/owned-session/artifact-admission', () => ({ withOwnedArtifactAdmission: async (_root: string, fn: () => unknown) => fn() }));
vi.mock('@/lib/orchestrator/lifecycle-mutation-lock', () => ({ withPacketLifecycleSpawnLock: async (_id: string, fn: () => unknown) => fn() }));
vi.mock('@/lib/runtimes/shared/owned-session/run-process-proof', () => ({ probeOwnedRunMarker: async () => 'unknown', resolveSpawnedProcessGroupId: async (pid: number) => pid }));
const { createOwnedRunController } = await import('@/lib/runtimes/shared/owned-session/run-controller');
let root: string; let namespace: string; let repo: string; let session: OwnedSessionRecord;
let prior: NodeJS.ProcessEnv; let packetId: string; let runtimeRoot: string;
function git(...args: string[]) { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim(); }
beforeEach(async () => {
  prior = { ...process.env }; h.grant.mockReset(); h.spawn.mockReset(); h.bridge.mockReset(); h.prepare.mockReset(); h.ready.mockReset();
  h.sync.mockImplementation((await vi.importActual<typeof import('node:fs')>('node:fs')).fsyncSync);
  root = mkdtempSync(join(realpathSync(tmpdir()), 'runtime-observation-')); repo = join(root, 'repo'); mkdirSync(repo);
  git('init', '-q'); writeFileSync(join(repo, 'source.txt'), 'original'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  const created = createImprovementNamespace({ parentDirectory: root, repository: repo, experimentId: 'fixture' });
  // Fixture models the child-process namespace boundary without spawning a model or provider.
  const marker = { ...created.namespace, creatorPid: process.pid + 100000 };
  namespace = marker.root; const markerPath = join(namespace, '.refinement-namespace.json');
  chmodSync(markerPath, 0o600); writeFileSync(markerPath, JSON.stringify(marker)); chmodSync(markerPath, 0o400);
  Object.assign(process.env, created.env, { O8_REFINEMENT_NAMESPACE_DIGEST: digest(marker), O8_CRASH_SURVIVABLE_WORKERS: '1', O8_WORKER_SANDBOX: '0' });
  const manifest: ImprovementManifest = { id: 'fixture', repository: repo, baselineRevision: git('rev-parse', 'HEAD'),
    contractDigest: 'a'.repeat(64), verifierDigest: 'b'.repeat(64), permissionsDigest: 'c'.repeat(64),
    runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high', provenance: 'native', mode: 'parallel', k: 1,
    maxStages: 9, maxStageWallMs: 1000, maxInputBytes: 100000, baseline: { instructions: 'Fixture only.' },
    tasks: [{ id: 'A', domain: 'code', prompt: 'Fixture task.' }] };
  const journal = createImprovementJournal(join(namespace, 'harness-refinement'));
  const initial = journal.append(createExperiment(manifest), null); const pending = journal.append(advanceExperiment(initial), initial.revision);
  packetId = prepareImprovementPacketBinding({ experimentId: 'fixture', requestId: pending.pending!.id, mountDigest: 'd'.repeat(64) }).packetId;
  bindImprovementPacketLane(packetId, 'lane'); runtimeRoot = join(namespace, 'owned'); mkdirSync(runtimeRoot);
  const sessionDir = join(runtimeRoot, 'fixture'); mkdirSync(sessionDir);
  session = { surfaceId: 'codex-owned:fixture', packetId, laneId: 'lane', sessionDir, cwd: repo, repoPath: repo,
    title: 'Fixture', createdAt: 'fixture', updatedAt: 'fixture', latestPrompt: '', latestSummary: '', model: manifest.model,
    effort: 'high', recentRuns: [], runIdentityLedger: { version: 1, complete: true, totalRuns: 0 } };
  h.spawn.mockImplementation(() => Object.assign(new EventEmitter(), { pid: 424242, stdin: { end: vi.fn() }, unref: vi.fn() }));
  h.bridge.mockRejectedValue(new Error('ambiguous bridge'));
});
afterEach(() => { process.env = prior; rmSync(root, { recursive: true, force: true }); });
function controller() {
  let durable = structuredClone(session);
  const unused = async (): Promise<never> => { throw new Error('Unexpected fixture IO call.'); };
  const io: OwnedSessionIo = { findSession: async () => structuredClone(durable),
    saveSession: async (next) => { durable = structuredClone(next); },
    ensureRoot: unused, listSessionDirs: unused, loadSession: unused,
    findArchivedSession: unused, archiveSession: unused };
  const adapter = { launchArgs: ({ prompt }: { prompt: string }) => ['--prompt', `adapter:${prompt}`],
    launchStdin: () => 'adapter stdin', extraSpawnEnv: async () => { h.prepare(); return { SECRET_TOKEN: 'never-record-this' }; },
    resumeArgs: () => [], parseRunLog: () => ({ entries: [], completedTurn: false }), binaryName: 'codex' } as unknown as OwnedRuntimeAdapter;
  return createOwnedRunController({ root: runtimeRoot, adapter, runtimeId: 'codex', humanLabel: 'Fixture', retryDelayMs: 100,
    stderrNoise: [], io, withSurfaceLock: async (_id, fn) => fn(), invalidateFleetCache: () => {},
    workspaceSpawnGuard: async () => ({ status: 'available', source: 'no-snapshot' }) });
}
function read(phase: 'prepared' | 'started') { return JSON.parse(readFileSync(join(namespace, `${digest(packetId)}.runtime-${phase}.json`), 'utf8')); }
it('captures final adapter prompt/argv/stdin and actual fake process identity at the controller seam', async () => {
  const run = await controller().spawnOwnedRun(session, 'input', 'launch');
  const prepared = read('prepared'); const started = read('started');
  expect(h.spawn).toHaveBeenCalledOnce(); expect(h.bridge).not.toHaveBeenCalled();
  expect(prepared).toMatchObject({ trust: 'untrusted-observation', runtimeArgvDigest: digest(['--prompt', 'adapter:input']),
    stdinDigest: digest('adapter stdin'), source: { head: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') },
    runId: run.id, workspace: { path: repo }, runtimeRoot: { path: runtimeRoot } });
  expect(prepared.finalArgvDigest).toBe(digest([h.spawn.mock.calls[0][0], ...h.spawn.mock.calls[0][1]]));
  expect(started).toMatchObject({ preparedDigest: digest(prepared), process: { pid: 424242, processGroupId: 424242, processMarker: run.id } });
  expect(JSON.stringify(prepared)).not.toContain('never-record-this'); expect(JSON.stringify(prepared)).not.toContain('secret-token');
  const actual = await vi.importActual<typeof import('@/lib/harness/improvement/launch-guard')>('@/lib/harness/improvement/launch-guard');
  expect(() => actual.assertImprovementPacketLaunch({ packetId, laneId: 'lane', repository: repo, runtime: 'codex', model: session.model, effort: session.effort, boundary: 'lane-spawn' })).toThrow('trusted launch authorization');
});
it('refuses source mutation by extraSpawnEnv after early preparation, with zero spawn', async () => {
  h.prepare.mockImplementation(() => writeFileSync(join(repo, 'source.txt'), 'changed after preparation'));
  await expect(controller().spawnOwnedRun(session, 'input', 'launch')).rejects.toThrow('immutable source');
  expect(h.spawn).not.toHaveBeenCalled(); expect(h.bridge).not.toHaveBeenCalled();
});
it('fails closed when observation fsync fails', async () => {
  const run = controller(); h.sync.mockImplementation(() => { throw new Error('injected fsync failure'); });
  await expect(run.spawnOwnedRun(session, 'input', 'launch')).rejects.toThrow('injected fsync failure');
  expect(h.spawn).not.toHaveBeenCalled();
});
it.each(['model', 'resume', 'duplicate', 'bridge'] as const)('refuses %s before preparation or process effects', async kind => {
  if (kind === 'model') session.model = 'different';
  if (kind === 'duplicate') session.runIdentityLedger!.totalRuns = 1;
  if (kind === 'bridge') process.env.O8_CRASH_SURVIVABLE_WORKERS = '0';
  await expect(controller().spawnOwnedRun(session, 'input', kind === 'resume' ? 'resume' : 'launch')).rejects.toThrow(/Refinement/);
  expect(h.prepare).not.toHaveBeenCalled(); expect(h.ready).not.toHaveBeenCalled(); expect(h.spawn).not.toHaveBeenCalled(); expect(h.bridge).not.toHaveBeenCalled();
});
it('leaves ordinary bridge fallback behavior unchanged', async () => {
  delete session.packetId; delete session.laneId; process.env.O8_CRASH_SURVIVABLE_WORKERS = '0';
  await controller().spawnOwnedRun(session, 'input', 'launch');
  expect(h.bridge).toHaveBeenCalledOnce(); expect(h.spawn).toHaveBeenCalledOnce();
});
it('refuses bridge mode changed by preparation, without attempting or falling back', async () => {
  h.prepare.mockImplementation(() => { process.env.O8_CRASH_SURVIVABLE_WORKERS = '0'; });
  await expect(controller().spawnOwnedRun(session, 'input', 'launch')).rejects.toThrow('bridge selection changed');
  expect(h.bridge).not.toHaveBeenCalled(); expect(h.spawn).not.toHaveBeenCalled();
});
it('retains an uncertain consumed attempt after post-spawn observation failure', async () => {
  const run = controller();
  h.spawn.mockImplementationOnce(() => {
    h.sync.mockImplementation(() => { throw new Error('post-spawn fsync failure'); });
    return Object.assign(new EventEmitter(), { pid: 424242, stdin: { end: vi.fn() }, unref: vi.fn() });
  });
  await expect(run.spawnOwnedRun(session, 'input', 'launch')).rejects.toThrow('outcome uncertain');
  expect(h.spawn).toHaveBeenCalledOnce(); expect(read('prepared').runId).toBe(session.activeRun!.id);
  await expect(run.spawnOwnedRun(session, 'input', 'launch')).rejects.toThrow('single attempt differs');
  expect(h.spawn).toHaveBeenCalledOnce();
});
it('does not reconstruct a fresh attempt by clearing the mutable session ledger', async () => {
  const fresh = structuredClone(session); await controller().spawnOwnedRun(session, 'input', 'launch');
  session = fresh;
  await expect(controller().spawnOwnedRun(session, 'input', 'launch')).rejects.toThrow('single attempt differs');
  expect(h.spawn).toHaveBeenCalledOnce();
});

it('keeps the direct production controller held before readiness, config, tokens or process effects', async () => {
  const actual = await vi.importActual<typeof import('@/lib/harness/improvement/launch-guard')>('@/lib/harness/improvement/launch-guard');
  h.grant.mockImplementation(actual.assertImprovementPacketLaunch);
  await expect(controller().spawnOwnedRun(session, 'input', 'launch')).rejects.toThrow('trusted launch authorization');
  expect(h.prepare).not.toHaveBeenCalled(); expect(h.ready).not.toHaveBeenCalled(); expect(h.spawn).not.toHaveBeenCalled(); expect(h.bridge).not.toHaveBeenCalled();
});

it('observes an actual isolated git worktree using immutable repository ownership', async () => {
  const worktree = join(root, 'worktree'); git('worktree', 'add', '--detach', worktree, 'HEAD');
  session.repoPath = worktree; session.cwd = worktree;
  await controller().spawnOwnedRun(session, 'input', 'launch');
  expect(read('prepared')).toMatchObject({ workspace: { path: worktree }, source: { head: git('rev-parse', 'HEAD') } });
  expect(h.spawn.mock.calls[0][2].cwd).toBe(worktree);
});
it('keeps refresh readable while suppressing recovery after durable ownership becomes stale', async () => {
  const run = controller();
  writeFileSync(join(namespace, 'harness-refinement-packets', `${digest(packetId)}.binding.json`), '{}');
  await expect(run.refreshSession(session)).resolves.toBe(session);
  expect(h.spawn).not.toHaveBeenCalled(); expect(h.ready).not.toHaveBeenCalled();
  await expect(run.spawnOwnedRun(session, 'input', 'launch')).rejects.toThrow();
});
it('rejects changed durable preparation pins rather than capturing stale model metadata', async () => {
  h.prepare.mockImplementation(() => { session.model = 'changed-after-preparation'; });
  await expect(controller().spawnOwnedRun(session, 'input', 'launch')).rejects.toThrow('pins changed during preparation');
  expect(h.spawn).not.toHaveBeenCalled();
});

it('refuses an ambiguous bridge selected by asynchronous readiness before any bridge call', async () => {
  h.ready.mockImplementation(() => { process.env.O8_CRASH_SURVIVABLE_WORKERS = '0'; });
  await expect(controller().spawnOwnedRun(session, 'input', 'launch')).rejects.toThrow('bridge selection changed before spawn');
  expect(h.bridge).not.toHaveBeenCalled(); expect(h.spawn).not.toHaveBeenCalled();
});
