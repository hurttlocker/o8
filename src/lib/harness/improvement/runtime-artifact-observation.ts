import 'server-only';
import { dirname, join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, existsSync, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs';
import { getOwnedSessionLifecycle } from '@/lib/runtimes/shared/owned-session-lifecycle';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';
import { withOwnedArtifactAdmission } from '@/lib/runtimes/shared/owned-session/artifact-admission';
import { withPacketLifecycleSpawnLock } from '@/lib/orchestrator/lifecycle-mutation-lock';
import { probeOwnedSessionProcessQuiescence } from '@/lib/workspace/process-probes';
import { synthesizeProcessQuiescence } from '@/lib/workspace/process-quiescence';
import { assertImprovementDirectory, readImprovementPrivateFile, requireImprovementNamespace, writeImprovementPrivateOnce } from './namespace';
import { ownedImprovementBinding, type PreparedRuntimeObservation } from './runtime-observation';
import type { ImprovementPacketBinding } from './launch-guard';
import { artifactInventory, canonical, digest, object, text } from './validation';

export interface RuntimeArtifactObservationInput {
  experimentId: string;
  requestId: string;
  packetId: string;
  surfaceId: string;
  runId: string;
}
export interface RuntimeArtifactObservationCaptured {
  status: 'observed'; trust: 'untrusted-observation'; authorizesExecution: false;
  snapshotHash: string; scope: 'operator-inventory-only'; evaluatorExclusion: 'unverified';
}
export interface RuntimeArtifactObservationHeld {
  status: 'held';
  trust: 'untrusted-observation';
  authorizesExecution: false;
  reason: 'runtime_evidence_unavailable' | 'artifact_scope_unavailable';
}
function fail(): never { throw new Error('Runtime observation evidence is incomplete or changed.'); }

/** Paths-only integrity inspection. Never read an out-of-scope candidate's bytes. */
function inspectSource(binding: ImprovementPacketBinding, workspace: string): { head: string; tree: string } {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    NODE_ENV: process.env.NODE_ENV, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const gitAt = (cwd: string, ...args: string[]): string => execFileSync('git', ['--no-optional-locks',
    '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.ignorestat=false', '-c', 'core.attributesFile=/dev/null',
    '-C', cwd, ...args], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'], env });
  const git = (...args: string[]) => gitAt(workspace, ...args);
  if (realpathSync(workspace) !== workspace || git('rev-parse', '--show-toplevel').trim() !== workspace
    || git('rev-parse', '--verify', 'HEAD').trim() !== binding.manifest.baselineRevision
    || git('config', '--null', '--name-only', '--list').split('\0').some(key => key.toLowerCase().startsWith('filter.'))
    || /(^|\n)160000 /.test(git('ls-files', '--stage'))
    || git('ls-files', '-v', '-z').split('\0').some(entry => entry && /^[a-zS]/.test(entry))
    || realpathSync(resolve(workspace, git('rev-parse', '--git-common-dir').trim())) !== realpathSync(resolve(
      binding.manifest.repository, gitAt(binding.manifest.repository, 'rev-parse', '--git-common-dir').trim()))) fail();
  const allowed = new Set(binding.manifest.artifactInventory?.files ?? []);
  // Include ignored files; --untracked-files=all prevents directory collapsing.
  const changed = git('status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching');
  for (const entry of changed.split('\0').filter(Boolean)) {
    if (entry.length < 4 || entry[2] !== ' ' || !/^[ MA?!]{2}$/.test(entry.slice(0, 2)) || !allowed.has(entry.slice(3))) fail();
  }
  return { head: git('rev-parse', '--verify', 'HEAD').trim(), tree: git('rev-parse', '--verify', 'HEAD^{tree}').trim() };
}
function identity(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid
    && a.nlink === b.nlink && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function capture(workspace: string, inventory: { files: string[]; maxFileBytes: number; maxTotalBytes: number }) {
  let total = 0;
  return inventory.files.map(path => {
    const target = join(workspace, path);
    assertImprovementDirectory(dirname(target), false);
    const before = lstatSync(target);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.geteuid!()
      || before.size > inventory.maxFileBytes || (total += before.size) > inventory.maxTotalBytes) fail();
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!identity(before, fstatSync(fd))) fail();
      const bytes = Buffer.alloc(before.size); let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!count) fail();
        offset += count;
      }
      assertImprovementDirectory(dirname(target), false);
      if (!identity(before, fstatSync(fd)) || !identity(before, lstatSync(target))) fail();
      return { path, sha256: createHash('sha256').update(bytes).digest('hex'), bytesBase64: bytes.toString('base64') };
    } finally { closeSync(fd); }
  });
}

/**
 * Passive, fail-closed terminal observation. Same-UID storage is not authority.
 * There is deliberately no caller-selected path, probe result, or success receipt.
 * Only an initial manifest inventory can scope candidate reads. Hash-only contracts
 * cannot attest evaluator exclusion. This collector never settles an engine run.
 */
export async function collectRuntimeArtifactObservation(
  input: RuntimeArtifactObservationInput,
): Promise<RuntimeArtifactObservationHeld | RuntimeArtifactObservationCaptured> {
  try {
    object(input, ['experimentId', 'requestId', 'packetId', 'surfaceId', 'runId']);
    for (const value of Object.values(input)) text(value, 1024);
    const namespace = requireImprovementNamespace();
    if (namespace.experimentId !== input.experimentId) fail();
    const lifecycle = getOwnedSessionLifecycle(input.surfaceId);
    if (!lifecycle?.getWorkspaceBinding) fail();
    const root = lifecycle.resolveRoot();
    if (!root.startsWith(`${namespace.root}${sep}`)) fail();
    const rootStat = assertImprovementDirectory(root);
    const name = input.surfaceId.slice(lifecycle.surfaceIdPrefix.length);
    if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name)) fail();
    const sessionDir = join(root, name);
    // Match spawn lock ordering exactly. Never acquire the packet lock first.
    return await withOwnedArtifactAdmission(root, () => withPacketLifecycleSpawnLock(input.packetId, async (): Promise<RuntimeArtifactObservationHeld | RuntimeArtifactObservationCaptured> => {
      const read = async () => {
        if (canonical(requireImprovementNamespace()) !== canonical(namespace)
          || lifecycle !== getOwnedSessionLifecycle(input.surfaceId) || lifecycle.resolveRoot() !== root) fail();
        const currentRoot = assertImprovementDirectory(root);
        if (currentRoot.dev !== rootStat.dev || currentRoot.ino !== rootStat.ino) fail();
        const sessionStat = assertImprovementDirectory(sessionDir);
        const session = JSON.parse(readImprovementPrivateFile(join(sessionDir, 'session.json'), 1024 * 1024)) as OwnedSessionRecord;
        const binding = ownedImprovementBinding(session, lifecycle.runtimeId);
        if (!binding || binding.experimentId !== input.experimentId || binding.requestId !== input.requestId
          || binding.packetId !== input.packetId || session.packetId !== input.packetId
          || session.surfaceId !== input.surfaceId || session.sessionDir !== sessionDir || !session.laneId
          || session.cwd !== session.repoPath
          || session.activeRun || session.autoRetry || (session.retryCount ?? 0) !== 0
          || session.orphanedAt || session.detachedAt || session.controlledTask
          || session.executionPolicy !== undefined
          || session.runIdentityLedger?.complete !== true || session.runIdentityLedger.totalRuns !== 1
          || !Array.isArray(session.recentRuns) || session.recentRuns.length !== 1) fail();
        const run = session.recentRuns[0]!;
        if (run.id !== input.runId || run.mode !== 'launch' || run.outcome !== 'finished' || !run.finishedAt
          || run.detachMode !== 'detached' || run.spawnState !== 'started' || run.modelFallback
          || run.childExit?.classification !== 'clean-exit' || run.childExit.code !== 0 || run.childExit.signal !== null
          || run.interruptRequestedAt || run.sandboxDenial
          || !run.commandIdentity || !run.processMarker || !Number.isSafeInteger(run.pid) || run.pid <= 0
          || !Number.isSafeInteger(run.processGroupId) || run.processGroupId! <= 0) fail();
        const prepared = JSON.parse(readImprovementPrivateFile(join(namespace.root,
          `${digest(input.packetId)}.runtime-prepared.json`))) as PreparedRuntimeObservation;
        for (const key of ['inputPromptDigest', 'runtimeArgvDigest', 'finalArgvDigest', 'stdinDigest', 'configDigest'] as const) {
          if (typeof prepared[key] !== 'string' || !/^[a-f0-9]{64}$/.test(prepared[key])) fail();
        }
        if (canonical(prepared.attemptPolicy) !== canonical({ mode: 'launch-only', spawn: 'direct', recovery: 'refused', consumption: 'write-once-packet' })) fail();
        if (canonical(prepared.coverage) !== canonical({ configuration: 'allowlisted-metadata-only', mounts: 'declarative-only', confinement: 'not-attested' })) fail();
        const started = JSON.parse(readImprovementPrivateFile(join(namespace.root,
          `${digest(input.packetId)}.runtime-started.json`)));
        if (prepared.schema !== 'o8/refinement-runtime-observation/v1' || prepared.trust !== 'untrusted-observation'
          || prepared.phase !== 'prepared' || prepared.experimentId !== input.experimentId
          || prepared.requestId !== input.requestId || prepared.packetId !== input.packetId
          || prepared.bindingDigest !== digest(binding) || prepared.sessionId !== input.surfaceId
          || prepared.runId !== input.runId || prepared.laneId !== session.laneId
          || prepared.namespaceId !== namespace.id || prepared.namespaceDigest !== digest(namespace)
          || prepared.storageGeneration.device !== namespace.device || prepared.storageGeneration.inode !== namespace.inode
          || prepared.expectedMountDigest !== binding.mountDigest || !/^[a-f0-9]{64}$/.test(prepared.mountDigest)
          || started.schema !== 'o8/refinement-runtime-process/v1' || started.trust !== 'untrusted-observation'
          || started.phase !== 'started' || started.preparedDigest !== digest(prepared)
          || started.sessionId !== input.surfaceId || started.runId !== input.runId
          || canonical(started.process) !== canonical({ pid: run.pid, processGroupId: run.processGroupId,
            processMarker: run.processMarker, commandIdentity: run.commandIdentity })) fail();
        const workspace = assertImprovementDirectory(session.cwd, false);
        if (canonical(prepared.workspace) !== canonical({ path: session.cwd, device: workspace.dev, inode: workspace.ino })
          || canonical(prepared.runtimeRoot) !== canonical({ path: root, device: rootStat.dev, inode: rootStat.ino })
          || canonical(prepared.sessionDirectory) !== canonical({ path: sessionDir, device: sessionStat.dev, inode: sessionStat.ino })) fail();
        const receipt = await lifecycle.getWorkspaceBinding!(input.surfaceId);
        if (!receipt || receipt.surfaceId !== input.surfaceId || receipt.runtimeId !== lifecycle.runtimeId
          || receipt.sessionState !== 'active' || receipt.detached || receipt.activeRun !== null
          || receipt.binding.cwd !== session.cwd || receipt.binding.packetId !== input.packetId
          || !receipt.retainedRunsComplete || receipt.retainedRunTotal !== 1 || receipt.retainedRuns.length !== 1
          || receipt.retainedRuns[0]?.id !== input.runId || receipt.retainedRuns[0]?.outcome !== 'finished') fail();
        const retained = receipt.retainedRuns[0]!;
        for (const key of ['pid', 'processGroupId', 'commandIdentity', 'processMarker', 'spawnState', 'tmuxSession'] as const) {
          if (retained[key] !== run[key]) fail();
        }
        const source = inspectSource(binding, session.cwd);
        if (canonical(source) !== canonical(prepared.source)) fail();
        return { binding, session, prepared, started, receipt, workspace: { device: workspace.dev, inode: workspace.ino }, source };
      };
      const attemptName = `${digest(input.packetId)}.runtime-capture-attempt.json`;
      if (existsSync(join(namespace.root, attemptName))
        || existsSync(join(namespace.root, `${digest(input.packetId)}.runtime-artifacts.json`))) fail();
      const before = await read();
      const probe = async () => {
        const result = await probeOwnedSessionProcessQuiescence(input.surfaceId, before.session.cwd);
        // Independently recompute completeness; a top-level quiescent label is insufficient.
        if (result.state !== 'quiescent' || synthesizeProcessQuiescence(result.identity, result.probes).state !== 'quiescent'
          || result.identity.sessionKey !== input.surfaceId || result.identity.retainedRuns?.length !== 1
          || result.identity.retainedRuns[0]?.runId !== input.runId) fail();
        const probed = result.identity.retainedRuns[0]!;
        const pinned = before.session.recentRuns[0]!;
        for (const key of ['pid', 'processGroupId', 'commandIdentity', 'processMarker', 'spawnState', 'tmuxSession'] as const) {
          if (probed[key] !== pinned[key]) fail();
        }
        if (probed.outcome !== 'finished' || probed.pidIdentity !== 'not_applicable') fail();
      };
      await probe();
      const inventory = before.binding.manifest.artifactInventory;
      if (!inventory) return { status: 'held', trust: 'untrusted-observation', authorizesExecution: false,
        reason: 'artifact_scope_unavailable' };
      artifactInventory(inventory);
      writeImprovementPrivateOnce(namespace.root, attemptName, { schema: 'o8/refinement-capture-attempt/v1',
        trust: 'untrusted-observation', packetId: input.packetId, runId: input.runId,
        preparedDigest: digest(before.prepared), inventoryDigest: digest(inventory) });
      const files = capture(before.session.cwd, inventory);
      if (canonical(await read()) !== canonical(before)) fail();
      await probe();
      if (canonical(await read()) !== canonical(before)) fail();
      if (canonical(capture(before.session.cwd, inventory)) !== canonical(files)) fail();
      await probe();
      if (canonical(await read()) !== canonical(before)) fail();
      const snapshotHash = digest(files.map(({ path, sha256 }) => ({ path, sha256 })));
      const observation = { schema: 'o8/refinement-runtime-artifacts/v1', trust: 'untrusted-observation',
        authorizesExecution: false, scope: 'operator-inventory-only', evaluatorExclusion: 'unverified',
        contractScope: 'hash-only-not-verified', experimentId: input.experimentId, requestId: input.requestId,
        packetId: input.packetId, sessionId: input.surfaceId, runId: input.runId,
        preparedDigest: digest(before.prepared), startedDigest: digest(before.started),
        inventoryDigest: digest(inventory), snapshotHash, files };
      writeImprovementPrivateOnce(namespace.root, `${digest(input.packetId)}.runtime-artifacts.json`, observation);
      return { status: 'observed', trust: 'untrusted-observation', authorizesExecution: false,
        snapshotHash, scope: 'operator-inventory-only', evaluatorExclusion: 'unverified' };
    }));
  } catch {
    // Do not reflect process output, session prompts, filesystem paths or secrets.
    return { status: 'held', trust: 'untrusted-observation', authorizesExecution: false,
      reason: 'runtime_evidence_unavailable' };
  }
}
