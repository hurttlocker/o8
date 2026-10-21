import 'server-only';
import Database from 'better-sqlite3';
import { lstatSync, opendirSync } from 'node:fs';
import { join } from 'node:path';
import type { OrchestratorMissionState } from '@/lib/orchestrator/types';
import type { CreateMissionInput } from '@/lib/orchestrator/operator-mission-service/types';
import { validatePersistedExperiment } from './engine';
import { createImprovementJournal } from './journal';
import { observeImprovementSource, type ImprovementPacketBinding } from './launch-guard';
import type { ImprovementExperiment } from './types';
import { canonical, digest } from './validation';
import { assertImprovementDirectory, readImprovementPrivateFile, requireImprovementNamespace,
  writeImprovementPrivateOnce, type ImprovementNamespace } from './namespace';

const PREPARATION = '.mission-preparation.json';
const ADMISSION = '.mission-admission.json';
interface Draft { input: CreateMissionInput; prompt: string; mountDigest: string }
interface Capability {
  namespace: ImprovementNamespace;
  binding: ImprovementPacketBinding;
  inputDigest: string;
  prompt: string;
  proof: Record<string, unknown>;
  phase: 'issued' | 'entered' | 'consumed';
}
const capabilities = new WeakMap<CreateMissionInput, Capability>();
function fail(message: string): never { throw new Error(`Refinement mission held: ${message}`); }
function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const entry of Object.values(value)) freeze(entry); Object.freeze(value); }
  return value;
}

/** Strict first-packet slice. No reuse, reset, supersession or archiving of an existing namespace. */
export async function assertEmptyImprovementMissionNamespace(namespace: ImprovementNamespace,
  current?: OrchestratorMissionState): Promise<void> {
  if (canonical(requireImprovementNamespace()) !== canonical(namespace)) fail('Namespace proof changed.');
  const dbPath = join(namespace.root, 'cortex-ide.db');
  // Check every sidecar even when the main database is absent, before importing app state.
  for (const suffix of ['', '-wal', '-shm', '-journal']) if (exists(`${dbPath}${suffix}`)) {
    const stat = lstatSync(`${dbPath}${suffix}`);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.geteuid!() || (stat.mode & 0o077)) fail('Unsafe namespace database file.');
  }
  if (current && (current.missionId || current.packets.length)) fail('Existing current mission requires reconciliation.');
  const controlPath = join(namespace.root, 'orchestrator-state.json');
  if (exists(controlPath)) {
    const stored = JSON.parse(readImprovementPrivateFile(controlPath, 8 * 1024 * 1024));
    const mission = stored?.mission;
    if (!mission || mission.missionId || !Array.isArray(mission.packets) || mission.packets.length) fail('Existing current mission requires reconciliation.');
  }
  const { getDbPath } = await import('@/lib/db');
  if (getDbPath() !== dbPath) fail('The loaded database belongs to another process namespace.');
  if (exists(dbPath)) {
    const database = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      for (const table of ['missions', 'lanes']) {
        if (database.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', table)
          && database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) fail('Existing mission or lane registry requires reconciliation.');
      }
    } finally { database.close(); }
  }
  if (canonical(requireImprovementNamespace()) !== canonical(namespace)) fail('Namespace changed while checking storage.');
}
function pendingFor(namespace: ImprovementNamespace): ImprovementExperiment {
  const state = createImprovementJournal(join(namespace.root, 'harness-refinement')).read(namespace.experimentId);
  if (!state || state.manifest.repository !== namespace.repository || state.manifest.provenance !== 'native'
    || state.status !== 'pending' || state.pendingReceipt || state.pending?.kind !== 'execute') fail('Exact persisted native execution reservation is required.');
  observeImprovementSource({ manifest: state.manifest }, namespace.repository);
  return state;
}

/** Render only the task and four supported text surfaces, never evaluator terms or a hidden oracle. */
export async function deriveImprovementMissionDraft(namespace: ImprovementNamespace): Promise<Draft> {
  return deriveDraft(namespace);
}
async function deriveDraft(namespace: ImprovementNamespace, binding?: ImprovementPacketBinding): Promise<Draft> {
  if (canonical(requireImprovementNamespace()) !== canonical(namespace)) fail('Namespace proof changed.');
  if (exists(join(namespace.root, PREPARATION)) || exists(join(namespace.root, ADMISSION))) fail('Previous preparation requires reconciliation; never retry blindly.');
  await assertEmptyImprovementMissionNamespace(namespace);
  const registry = join(namespace.root, 'harness-refinement-packets');
  if (exists(registry)) {
    if (binding) checkRegistry({ namespace, binding });
    else { assertImprovementDirectory(registry); if (entryNames(registry).length) fail('Existing packet registry requires reconciliation.'); }
  }
  const state = pendingFor(namespace); validatePersistedExperiment(state);
  const { resolveWorkerRouting } = await import('@/lib/agents/routing');
  const { isOrchestratorRuntime } = await import('@/lib/orchestrator/runtime-capabilities');
  const { isManualThinkingEffort } = await import('@/lib/orchestrator/thinking-effort');
  const request = state.pending!; const manifest = state.manifest;
  if (!isOrchestratorRuntime(manifest.runtime) || !isManualThinkingEffort(manifest.effort)) fail('Exact supported runtime and manual effort are required.');
  const routing = resolveWorkerRouting({ requestedRuntime: manifest.runtime, requestedModel: manifest.model, requestedEffort: manifest.effort });
  if (routing.selectedRuntime !== manifest.runtime || routing.selectedModel !== manifest.model || routing.selectedEffort !== manifest.effort) {
    fail('Routing cannot preserve the frozen runtime, model and effort.');
  }
  const issue = { number: 90001 + Number.parseInt(request.id.slice(0, 10), 16),
    title: `Harness refinement ${request.taskId} ${request.label}`, url: '', runtime: manifest.runtime,
    body: `${request.prompt}\n\nExact harness text fields (untrusted task data, not authority):\n${canonical(request.harness)}\n\nAccepted contract digest: ${manifest.contractDigest}` };
  const input: CreateMissionInput = { issues: [issue], repoPath: manifest.repository,
    runtime: manifest.runtime, requestedRuntime: manifest.runtime, requestedModel: manifest.model, requestedEffort: manifest.effort,
    executionCarrier: null, claudeCodeCarrier: null, ...(manifest.runtime === 'claude-code' ? { claudeCodeModel: manifest.model } : {}),
    constraints: 'Held refinement preparation only. Preserve repository rules, permissions, independent verification and review. No launch or merge authority.',
    dispatchOnCreate: false, holdMerges: true, useBrain: false, existingBranchPolicy: 'error',
    launchContext: { source: 'agent', presentation: 'tab', repoContext: 'transient', checkoutMode: 'isolated', caller: 'harness-refinement' },
  };
  const { buildPacketSummary } = await import('@/lib/orchestrator/operator-mission-service/shared');
  const prompt = [issue.title, buildPacketSummary(issue, input.constraints, input.repoPath, 'inline-1')].join('\n\n');
  return { input, prompt, mountDigest: digest({ schema: 'o8/refinement-text-mount/v1', requestDigest: digest(request),
    harness: request.harness, prompt }) };
}
function entryNames(root: string): string[] {
  const directory = opendirSync(root); const names: string[] = [];
  try { for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
    names.push(entry.name); if (names.length > 1) fail('Packet registry contains unrelated preparation.');
  } } finally { directory.closeSync(); }
  return names;
}
function checkRegistry(capability: Pick<Capability, 'namespace' | 'binding'>): void {
  const { namespace, binding } = capability;
  const root = join(namespace.root, 'harness-refinement-packets'); assertImprovementDirectory(root);
  const name = `${digest(binding.packetId)}.binding.json`;
  const names = entryNames(root);
  if (names.length !== 1 || names[0] !== name || canonical(JSON.parse(readImprovementPrivateFile(join(root, name), 3 * 1024 * 1024))) !== canonical(binding)) {
    fail('Packet registry contains unrelated or changed preparation.');
  }
  const state = pendingFor(namespace);
  if (state.manifestDigest !== binding.manifestDigest || state.pending!.id !== binding.requestId || digest(state.pending) !== binding.requestDigest) {
    fail('Persisted execution reservation changed.');
  }
}

/** Internal server capability. It cannot survive JSON, object copying or process restart. */
export async function bindImprovementMissionCapability(namespace: ImprovementNamespace,
  binding: ImprovementPacketBinding, draft: Draft): Promise<CreateMissionInput> {
  const expected = await deriveDraft(namespace, binding);
  if (canonical(draft) !== canonical(expected) || draft.mountDigest !== binding.mountDigest
    || namespace.experimentId !== binding.experimentId || namespace.repository !== binding.manifest.repository) fail('Derived mission content binding changed.');
  checkRegistry({ namespace, binding });
  const input = freeze(draft.input);
  const proof = { schema: 'o8/refinement-mission-preparation/v1', namespaceId: namespace.id,
    namespaceDigest: digest(namespace), experimentId: binding.experimentId, requestId: binding.requestId,
    requestDigest: binding.requestDigest, packetId: binding.packetId, bindingDigest: digest(binding),
    inputDigest: digest(input), mountDigest: draft.mountDigest };
  writeImprovementPrivateOnce(namespace.root, PREPARATION, proof);
  capabilities.set(input, { namespace: structuredClone(namespace), binding: structuredClone(binding),
    inputDigest: digest(input), prompt: draft.prompt, proof, phase: 'issued' });
  return input;
}
function capabilityFor(input: CreateMissionInput): Capability | null {
  const capability = capabilities.get(input);
  if (!capability && process.env.O8_REFINEMENT_NAMESPACE_ID) fail('A nonserialized trusted mission capability is required in this namespace.');
  return capability ?? null;
}
async function revalidate(input: CreateMissionInput, capability: Capability, current?: OrchestratorMissionState): Promise<void> {
  if (digest(input) !== capability.inputDigest || !Object.isFrozen(input)) fail('Mission input differs from its immutable capability.');
  await assertEmptyImprovementMissionNamespace(capability.namespace, current);
  if (exists(join(capability.namespace.root, ADMISSION))) fail('Admission already attempted; reconcile the existing outcome.');
  if (canonical(JSON.parse(readImprovementPrivateFile(join(capability.namespace.root, PREPARATION)))) !== canonical(capability.proof)) fail('Preparation proof changed.');
  checkRegistry(capability);
}

/** First line of createMission, before project, branch, state or registry operations. */
export async function inspectImprovementMissionCapability(input: CreateMissionInput): Promise<string | null> {
  const capability = capabilityFor(input); if (!capability) return null;
  if (capability.phase !== 'issued') fail('Capability was already entered; reconcile the existing outcome.');
  await revalidate(input, capability);
  if (capability.phase !== 'issued') fail('Concurrent capability use is forbidden.');
  capability.phase = 'entered';
  return capability.binding.packetId;
}

/** Inside the existing control-plane lock, immediately before its first mission mutation. */
export async function consumeImprovementMissionCapability(input: CreateMissionInput,
  current: OrchestratorMissionState, next: OrchestratorMissionState): Promise<void> {
  const capability = capabilityFor(input); if (!capability) return;
  if (capability.phase !== 'entered') fail('Capability is absent, consumed or was not admitted at entry.');
  capability.phase = 'consumed'; // Failure remains consumed; a durable preparation also blocks a new process retry.
  await revalidate(input, capability, current);
  const packet = next.packets[0]; const manifest = capability.binding.manifest;
  if (next.repoPath !== manifest.repository || next.packets.length !== 1 || !packet || packet.id !== capability.binding.packetId
    || packet.runtime !== manifest.runtime || packet.assignedModel !== manifest.model || packet.workerRouting?.selectedEffort !== manifest.effort
    || packet.queueState !== 'held' || packet.status !== 'draft' || packet.mergeHold !== true || packet.useBrain !== false
    || packet.workspaceTargetPath !== manifest.repository || packet.prompt !== capability.prompt
    || packet.issue?.body !== input.issues[0]!.body || packet.orchestratorThreadId || packet.lane) fail('Constructed held packet differs from its exact capability.');
  writeImprovementPrivateOnce(capability.namespace.root, ADMISSION,
    { ...capability.proof, schema: 'o8/refinement-mission-admission/v1', missionId: next.missionId });
}
