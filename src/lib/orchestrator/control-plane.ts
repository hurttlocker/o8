import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { currentLaneMergePolicy } from '@/lib/lane/dogfood-guard';
import { getLaneEvents, listLanes } from '@/lib/lane/registry';
import { recoveryInfoFromLaneEvents } from '@/lib/lane/recovery-info';
import type { Lane, LaneEvent } from '@/lib/lane/types';
import type { DomainLaneSummary } from '@/lib/orchestrator/domain-lane-summary';
import type { OrchestratorMissionState, OrchestratorRuntimeTruth } from '@/lib/orchestrator/types';
import { packetContextObservationFromEvent } from '@/lib/orchestrator/packet-context-telemetry';
import {
  createEmptyOrchestratorMissionState,
  normalizeOrchestratorMissionState,
  reconcileOrchestratorMissionState,
  updateOrchestratorMissionState,
} from '@/lib/orchestrator/store';

const ORCHESTRATOR_DIR = getDataDir();
const ORCHESTRATOR_PATH = join(ORCHESTRATOR_DIR, 'orchestrator-state.json');
const ORCHESTRATOR_TMP_PATH = `${ORCHESTRATOR_PATH}.tmp`;

// #460/#1488 — In-process mutex to serialize read-modify-write on
// orchestrator-state.json. FIFO chain: each acquirer waits on the previous
// holder's promise and enqueues its own resolver. (The previous single
// module-level resolver was clobbered by concurrent waiters — the second
// waiter's promise got resolved in the first's place and the chain deadlocked.)
let lockTail: Promise<void> = Promise.resolve();
const lockReleases: Array<() => void> = [];

// #1488 — Cross-process lock. The in-process chain above only serializes writers
// inside ONE Node process, but next-server and ws-server both read-modify-write
// this file: a packet created via the API could be erased seconds later when the
// other process persisted a snapshot read before the create (queued tasks
// "evaporating" between o8_task_create and o8_task_dispatch). mkdir is atomic on
// POSIX, so the lock dir is the mutex; a holder writes its pid+timestamp inside,
// and a lock older than LOCK_STALE_MS is broken (crashed holder).
const LOCK_DIR = `${ORCHESTRATOR_PATH}.lock`;
const LOCK_META = join(LOCK_DIR, 'holder.json');
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 25;
const LOCK_WAIT_BUDGET_MS = 8_000;

export class ControlPlaneLockTimeoutError extends Error {
  constructor(public readonly waitTimeoutMs: number) {
    super(`Timed out after ${waitTimeoutMs}ms waiting for the orchestrator control-plane lock.`);
    this.name = 'ControlPlaneLockTimeoutError';
  }
}

interface ControlPlaneLockOptions {
  waitTimeoutMs?: number;
}

function lockIsStale(): boolean {
  try {
    const meta = JSON.parse(readFileSync(LOCK_META, 'utf8')) as { at?: number };
    return typeof meta.at !== 'number' || Date.now() - meta.at > LOCK_STALE_MS;
  } catch {
    // Unreadable/missing metadata: judge by the dir's own age via a fresh stat-less
    // heuristic — treat as stale so a crashed holder can't wedge both processes.
    return true;
  }
}

async function acquireFsLock(): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_BUDGET_MS;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      writeFileSync(LOCK_META, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
      return;
    } catch {
      if (lockIsStale()) {
        try {
          rmSync(LOCK_DIR, { recursive: true, force: true });
        } catch { /* another process may have broken it first */ }
        continue;
      }
      if (Date.now() > deadline) {
        // Fail open with a loud log rather than deadlocking state writes: a lost
        // update is recoverable by the ancestry reconciler; a wedged control
        // plane is not.
        console.error('[control-plane] cross-process lock wait exceeded budget — proceeding without lock');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

function releaseFsLock(): void {
  try {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch (error) {
    console.error('[control-plane] failed to release cross-process lock:', error);
  }
}

async function acquireLock(options: ControlPlaneLockOptions = {}): Promise<void> {
  const waitForPrevious = lockTail;
  let release!: () => void;
  lockTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  lockReleases.push(release);
  const waitTimeoutMs = options.waitTimeoutMs;
  if (waitTimeoutMs !== undefined) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const outcome = await Promise.race([
      waitForPrevious.then(() => 'acquired' as const),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), waitTimeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome === 'timeout') {
      // Keep the FIFO chain healthy after this waiter leaves. Once its
      // predecessor releases, remove this abandoned queue slot and resolve it
      // so later waiters can continue without acquiring or releasing the FS lock.
      void waitForPrevious.then(() => {
        const index = lockReleases.indexOf(release);
        if (index >= 0) lockReleases.splice(index, 1);
        release();
      });
      throw new ControlPlaneLockTimeoutError(waitTimeoutMs);
    }
  } else {
    await waitForPrevious;
  }
  await acquireFsLock();
}

function releaseLock(): void {
  releaseFsLock();
  lockReleases.shift()?.();
}

interface OrchestratorControlPlaneFile {
  version: 1;
  mission: OrchestratorMissionState;
}

function ensureControlPlaneDir() {
  mkdirSync(ORCHESTRATOR_DIR, { recursive: true });
}

function readPersistedControlPlaneState(): OrchestratorMissionState {
  try {
    const raw = readFileSync(ORCHESTRATOR_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<OrchestratorControlPlaneFile>;
    return normalizeOrchestratorMissionState(parsed.mission ?? createEmptyOrchestratorMissionState());
  } catch {
    return createEmptyOrchestratorMissionState();
  }
}

export function readOrchestratorControlPlaneState(): OrchestratorMissionState {
  const mission = readPersistedControlPlaneState();
  updateOrchestratorMissionState(mission);
  return mission;
}

export function writeOrchestratorControlPlaneState(state: OrchestratorMissionState) {
  ensureControlPlaneDir();
  const next: OrchestratorControlPlaneFile = {
    version: 1,
    mission: normalizeOrchestratorMissionState(state),
  };
  writeFileSync(ORCHESTRATOR_TMP_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameSync(ORCHESTRATOR_TMP_PATH, ORCHESTRATOR_PATH);
  updateOrchestratorMissionState(next.mission);
  return next.mission;
}

const RUNTIME_EXIT_OVERRIDE_STATUSES = new Set<Lane['status']>([
  'launching',
  'running',
  'recovering',
]);

function hasUnreconciledRuntimeExit(lane: Lane, events: LaneEvent[]): boolean {
  if (!RUNTIME_EXIT_OVERRIDE_STATUSES.has(lane.status)) return false;
  const runtimeExit = events.findLast((event) => event.verb === 'runtime_process_exit');
  if (!runtimeExit) return false;
  const classification = runtimeExit.payload.classification;
  const exitCode = runtimeExit.payload.exitCode;
  const signal = runtimeExit.payload.signal;
  if (classification === 'clean-exit' || (exitCode === 0 && (signal === null || signal === undefined))) {
    return false;
  }
  const exitAt = Date.parse(runtimeExit.timestamp);
  const laneEventAt = lane.lastEventAt ? Date.parse(lane.lastEventAt) : 0;
  if (!Number.isFinite(exitAt)) return false;
  return !Number.isFinite(laneEventAt) || exitAt >= laneEventAt;
}

export function buildDomainLaneSummaries(): DomainLaneSummary[] {
  const mergePolicy = currentLaneMergePolicy();
  return listLanes()
    .filter((lane) => lane.packetId)
    .map((lane) => {
      const events = getLaneEvents(lane.id, 100);
      const recovery = recoveryInfoFromLaneEvents(events);
      const runtimeExited = hasUnreconciledRuntimeExit(lane, events);
      const contextEvent = events.findLast((event) => event.verb === 'runtime_process_exit');
      return {
        laneId: lane.id,
        packetId: lane.packetId!,
        status: runtimeExited ? 'failed' : lane.status,
        sessionKey: lane.sessionKey,
        lastEventLabel: runtimeExited ? 'runtime_process_exit' : lane.lastEventLabel,
        recovery,
        contextObservation: contextEvent ? packetContextObservationFromEvent(contextEvent) : undefined,
        mergeMode: mergePolicy.mode,
        mergeModeNote: mergePolicy.note,
      };
    });
}

function needsRuntimeTruth(domainLanes: DomainLaneSummary[]): boolean {
  return domainLanes.some((lane) =>
    lane.status === 'reviewing' && lane.sessionKey?.startsWith('codex-owned:')
  );
}

async function buildRuntimeTruthSummaries(domainLanes: DomainLaneSummary[]): Promise<OrchestratorRuntimeTruth[]> {
  if (!needsRuntimeTruth(domainLanes)) return [];
  const { getRuntimeInventorySnapshot } = await import('@/lib/runtime/inventory');
  const snapshot = await getRuntimeInventorySnapshot({ fresh: true });
  return snapshot.agents
    .filter((agent) => agent.sessionKey && (agent.runtime === 'codex' || agent.runtime === 'claude-code'))
    .map((agent) => ({
      sessionKey: agent.sessionKey,
      runtime: agent.runtime === 'claude-code' ? 'claude-code' as const : 'codex' as const,
      status: agent.status ?? 'idle',
      currentTask: agent.currentTask ?? null,
      lastEventAt: agent.lastEventAt ?? null,
      workflowStageLabel: null,
      canSendInput: agent.runtimeSurface?.capabilities.sendInput ?? null,
      canInterrupt: agent.runtimeSurface?.capabilities.interrupt ?? null,
      runtimeAvailability: agent.runtimeSurface?.lifecycle?.availability ?? null,
      ownership: agent.runtimeSurface?.ownership ?? null,
    }));
}

export function reconcileOrchestratorControlPlaneState(
  state?: OrchestratorMissionState,
  runtimeTruth: OrchestratorRuntimeTruth[] = [],
  domainLanes: DomainLaneSummary[] = buildDomainLaneSummaries(),
) {
  const current = normalizeOrchestratorMissionState(state ?? readOrchestratorControlPlaneState());
  return reconcileOrchestratorMissionState(current, {
    laneSnapshots: [],
    runtimeTruth,
    domainLanes,
  });
}

export async function syncOrchestratorControlPlaneState(state?: OrchestratorMissionState) {
  await acquireLock();
  try {
    const domainLanes = buildDomainLaneSummaries();
    const runtimeTruth = await buildRuntimeTruthSummaries(domainLanes).catch(() => []);
    const reconciled = reconcileOrchestratorControlPlaneState(state, runtimeTruth, domainLanes);
    return writeOrchestratorControlPlaneState(reconciled);
  } finally {
    releaseLock();
  }
}

/**
 * #460 — Locked read-modify-write: read state, apply a mutation, reconcile, and persist.
 * Use this for any operation that needs exclusive access to orchestrator-state.json.
 *
 * If the callback returns an OrchestratorMissionState, that value is used as the
 * basis for reconcile + write instead of the pre-callback snapshot. This allows
 * callers that run a sub-operation (e.g. runDispatchTick) producing a new state
 * to persist that result without a second write that would clobber it.
 */
/**
 * #1488 — Lock-only variant: exclusive access (in-process + cross-process)
 * WITHOUT the end-of-lock reconcile+write that withLockedState performs. For
 * callers that must persist exact statuses (e.g. mission stop's honest
 * per-packet results) and do their own writeOrchestratorControlPlaneState —
 * a reconcile against not-yet-caught-up lane snapshots would rewrite them.
 */
export async function withControlPlaneLock<T>(
  fn: () => T | Promise<T>,
  options: ControlPlaneLockOptions = {},
): Promise<T> {
  await acquireLock(options);
  try {
    return await fn();
  } finally {
    releaseLock();
  }
}

export async function withLockedState<T>(
  fn: (state: OrchestratorMissionState) => T | Promise<T>,
  options: ControlPlaneLockOptions = {},
): Promise<{ result: T; state: OrchestratorMissionState }> {
  await acquireLock(options);
  try {
    const current = readOrchestratorControlPlaneState();
    const result = await fn(current);
    // If the callback returned a mission state, reconcile from that (post-operation
    // snapshot). Otherwise fall back to the mutated `current` object as before.
    const basisForReconcile: OrchestratorMissionState =
      result !== null
      && typeof result === 'object'
      && 'packets' in (result as object)
      && 'lanes' in (result as object)
        ? (result as unknown as OrchestratorMissionState)
        : current;
    const domainLanes = buildDomainLaneSummaries();
    const runtimeTruth = await buildRuntimeTruthSummaries(domainLanes).catch(() => []);
    const reconciled = reconcileOrchestratorControlPlaneState(basisForReconcile, runtimeTruth, domainLanes);
    const state = writeOrchestratorControlPlaneState(reconciled);
    return { result, state };
  } finally {
    releaseLock();
  }
}
