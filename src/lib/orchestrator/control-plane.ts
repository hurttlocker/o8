import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { listLanes } from '@/lib/lane/registry';
import type { DomainLaneSummary } from '@/lib/orchestrator/store';
import type { OrchestratorMissionState } from '@/lib/orchestrator/types';
import {
  createEmptyOrchestratorMissionState,
  normalizeOrchestratorMissionState,
  reconcileOrchestratorMissionState,
  updateOrchestratorMissionState,
} from '@/lib/orchestrator/store';

const ORCHESTRATOR_DIR = join(homedir(), '.o8');
const ORCHESTRATOR_PATH = join(ORCHESTRATOR_DIR, 'orchestrator-state.json');
const ORCHESTRATOR_TMP_PATH = `${ORCHESTRATOR_PATH}.tmp`;

// #460 — In-process mutex to serialize read-modify-write on orchestrator-state.json.
// Prevents race between headless loop ticks and manual API operations (reset_packet, etc.)
let lockPromise: Promise<void> | null = null;
let lockResolve: (() => void) | null = null;

function acquireLock(): Promise<void> {
  const waitForPrevious = lockPromise ?? Promise.resolve();
  lockPromise = new Promise<void>((resolve) => {
    lockResolve = resolve;
  });
  return waitForPrevious;
}

function releaseLock(): void {
  const resolve = lockResolve;
  lockResolve = null;
  lockPromise = null;
  resolve?.();
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

export function buildDomainLaneSummaries(): DomainLaneSummary[] {
  return listLanes()
    .filter((lane) => lane.packetId)
    .map((lane) => ({
      laneId: lane.id,
      packetId: lane.packetId!,
      status: lane.status,
      sessionKey: lane.sessionKey,
    }));
}

export function reconcileOrchestratorControlPlaneState(state?: OrchestratorMissionState) {
  const current = normalizeOrchestratorMissionState(state ?? readOrchestratorControlPlaneState());
  return reconcileOrchestratorMissionState(current, {
    laneSnapshots: [],
    runtimeTruth: [],
    domainLanes: buildDomainLaneSummaries(),
  });
}

export async function syncOrchestratorControlPlaneState(state?: OrchestratorMissionState) {
  await acquireLock();
  try {
    const reconciled = reconcileOrchestratorControlPlaneState(state);
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
export async function withLockedState<T>(
  fn: (state: OrchestratorMissionState) => T | Promise<T>,
): Promise<{ result: T; state: OrchestratorMissionState }> {
  await acquireLock();
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
    const reconciled = reconcileOrchestratorControlPlaneState(basisForReconcile);
    const state = writeOrchestratorControlPlaneState(reconciled);
    return { result, state };
  } finally {
    releaseLock();
  }
}
