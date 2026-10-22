import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { OwnedRunMode, OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';
import { crashSurvivableWorkersEnabled } from '@/lib/runtimes/shared/owned-session/crash-survival';
import { assertImprovementPacketLaunch, improvementPacketRecoveryHeld, readImprovementPacketBinding, readImprovementRuntimeBinding, observeImprovementSource, type ImprovementPacketBinding } from './launch-guard';
import { requireImprovementNamespace, writeImprovementPrivateOnce } from './namespace';
import { digest } from './validation';

export interface DirectoryIdentity { path: string; device: number; inode: number }
function directoryIdentity(path: string): DirectoryIdentity {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error('Refinement observation directory identity is unsafe.');
  return { path, device: stat.dev, inode: stat.ino };
}

/** Observation only: private same-user files are NOT protected against a writable worker. */
export interface PreparedRuntimeObservation {
  schema: 'o8/refinement-runtime-observation/v1';
  trust: 'untrusted-observation';
  phase: 'prepared';
  attemptPolicy: { mode: 'launch-only'; spawn: 'direct'; recovery: 'refused'; consumption: 'write-once-packet' };
  experimentId: string;
  requestId: string;
  packetId: string;
  bindingDigest: string;
  sessionId: string;
  runId: string;
  laneId: string;
  namespaceId: string;
  namespaceDigest: string;
  storageGeneration: { device: number; inode: number };
  workspace: DirectoryIdentity;
  runtimeRoot: DirectoryIdentity;
  sessionDirectory: DirectoryIdentity;
  source: { head: string; tree: string };
  inputPromptDigest: string;
  runtimeArgvDigest: string;
  finalArgvDigest: string;
  stdinDigest: string;
  configDigest: string;
  mountDigest: string;
  expectedMountDigest: string;
  coverage: { configuration: 'allowlisted-metadata-only'; mounts: 'declarative-only'; confinement: 'not-attested' };
}

function runtimeLaunchInput(session: OwnedSessionRecord, runtime: string) {
  const packetId = session.packetId ?? session.workspaceBinding?.packetId;
  if (session.packetId && session.workspaceBinding?.packetId && session.packetId !== session.workspaceBinding.packetId) {
    if (session.packetId.startsWith('harness-refinement-') || session.workspaceBinding.packetId.startsWith('harness-refinement-')) {
      throw new Error('Refinement observation held: workspace packet identity differs.');
    }
  }
  const binding = readImprovementPacketBinding({ packetId, laneId: session.laneId });
  return { packetId, laneId: session.laneId, repository: binding?.manifest.repository ?? session.repoPath, sourcePath: session.repoPath,
    runtime, model: session.model, effort: session.effort,
    executionCarrier: session.runtimeConfig?.executionCarrier,
    claudeCodeCarrier: session.runtimeConfig?.claudeCodeCarrier, boundary: 'lane-spawn' as const };
}

export function ownedImprovementBinding(session: OwnedSessionRecord, runtime: string): ImprovementPacketBinding | null {
  return readImprovementRuntimeBinding(runtimeLaunchInput(session, runtime));
}

export function ownedImprovementRecoveryHeld(session: OwnedSessionRecord): boolean {
  return improvementPacketRecoveryHeld({ packetId: session.packetId, laneId: session.laneId })
    || improvementPacketRecoveryHeld({ packetId: session.workspaceBinding?.packetId });
}

/** Call before preparation or backend readiness; no payload boolean can opt in or out. */
export function assertImprovementObservationAttempt(session: OwnedSessionRecord, runtime: string, mode: OwnedRunMode) {
  const binding = ownedImprovementBinding(session, runtime);
  if (!binding) return null;
  assertImprovementPacketLaunch(runtimeLaunchInput(session, runtime));
  const namespace = requireImprovementNamespace();
  if (namespace.experimentId !== binding.experimentId || namespace.repository !== binding.manifest.repository
    || !session.laneId || mode !== 'launch' || session.activeRun || session.recentRuns.length
    || session.runIdentityLedger?.complete !== true || session.runIdentityLedger.totalRuns !== 0
    || existsSync(join(namespace.root, `${digest(binding.packetId)}.runtime-prepared.json`))) {
    throw new Error('Refinement observation held: namespace, generation or single attempt differs.');
  }
  if (session.executionPolicy === undefined && !session.runtimeConfig?.executionCarrier && !crashSurvivableWorkersEnabled()) {
    throw new Error('Refinement observation held: ambiguous bridge and fallback paths are unsupported.');
  }
  return { binding, namespaceDigest: digest(namespace) };
}

export function recordPreparedRuntimeObservation(input: {
  namespaceDigest: string; root: string; session: OwnedSessionRecord; runtime: string; binding: ImprovementPacketBinding; runId: string; prompt: string;
  runtimeArgs: string[]; command: string; args: string[]; stdin: string | null;
  config: { sandboxed: boolean; mcpServerNames: string[]; mcpConfigPresent: boolean; isolatedConfigPresent: boolean };
  mounts: { readPaths: string[]; writablePaths: string[]; immutablePaths: string[]; materialization: unknown };
}): PreparedRuntimeObservation {
  const { session, binding } = input;
  assertImprovementPacketLaunch(runtimeLaunchInput(session, input.runtime));
  if (input.config.sandboxed || input.config.mcpConfigPresent || input.config.mcpServerNames.length || input.config.isolatedConfigPresent) {
    throw new Error('Refinement observation held: effective sandbox, MCP or isolated configuration is not fully represented.');
  }
  const current = ownedImprovementBinding(session, input.runtime);
  if (!current || digest(current) !== digest(binding)) throw new Error('Refinement observation binding changed after preparation.');
  const namespace = requireImprovementNamespace();
  if (digest(namespace) !== input.namespaceDigest || namespace.experimentId !== binding.experimentId || namespace.repository !== binding.manifest.repository) {
    throw new Error('Refinement observation namespace changed after preparation.');
  }
  const observation: PreparedRuntimeObservation = {
    schema: 'o8/refinement-runtime-observation/v1', trust: 'untrusted-observation', phase: 'prepared',
    attemptPolicy: { mode: 'launch-only', spawn: 'direct', recovery: 'refused', consumption: 'write-once-packet' },
    experimentId: binding.experimentId, requestId: binding.requestId, packetId: binding.packetId,
    bindingDigest: digest(binding), sessionId: session.surfaceId, runId: input.runId, laneId: session.laneId!,
    namespaceId: namespace.id, namespaceDigest: digest(namespace),
    storageGeneration: { device: namespace.device, inode: namespace.inode },
    workspace: directoryIdentity(session.repoPath), runtimeRoot: directoryIdentity(input.root),
    sessionDirectory: directoryIdentity(session.sessionDir),
    source: observeImprovementSource(binding, session.repoPath), inputPromptDigest: digest(input.prompt),
    runtimeArgvDigest: digest(input.runtimeArgs), finalArgvDigest: digest([input.command, ...input.args]),
    stdinDigest: digest(input.stdin), configDigest: digest({ ...input.config, runtime: input.runtime,
      model: binding.manifest.model, effort: binding.manifest.effort, executionCarrier: binding.executionCarrier,
      claudeCodeCarrier: binding.claudeCodeCarrier }), mountDigest: digest(input.mounts),
    expectedMountDigest: binding.mountDigest,
    coverage: { configuration: 'allowlisted-metadata-only', mounts: 'declarative-only', confinement: 'not-attested' },
  };
  writeImprovementPrivateOnce(namespace.root, `${digest(binding.packetId)}.runtime-prepared.json`, observation);
  return observation;
}

export function recordRuntimeProcessObservation(prepared: PreparedRuntimeObservation, process: {
  pid: number; processGroupId: number | undefined; processMarker: string; commandIdentity: string | undefined;
}): void {
  const namespace = requireImprovementNamespace();
  if (namespace.id !== prepared.namespaceId || digest(namespace) !== prepared.namespaceDigest) {
    throw new Error('Refinement process observation storage generation changed; spawn outcome is uncertain.');
  }
  try { writeImprovementPrivateOnce(namespace.root, `${digest(prepared.packetId)}.runtime-started.json`, {
    schema: 'o8/refinement-runtime-process/v1', trust: 'untrusted-observation', phase: 'started',
    processBirthIdentity: 'unknown', clearance: 'not-attested',
    preparedDigest: digest(prepared), sessionId: prepared.sessionId, runId: prepared.runId,
    process: { ...process, processGroupId: process.processGroupId ?? null, commandIdentity: process.commandIdentity ?? null },
  }); } catch (cause) {
    throw new Error('Refinement process observation persistence failed after spawn; outcome uncertain; do not retry.', { cause });
  }
}
