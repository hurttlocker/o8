import 'server-only';

import { getSqlite } from '@/lib/db';
import { buildDependencyGraph } from '@/lib/orchestrator/dag';
import { normalizeOrchestratorMissionState } from '@/lib/orchestrator/store';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

interface MissionStateRow {
  id: string;
  mission_state_json: string | null;
  created_at: number;
  archived_at: number | null;
}

export interface MissionRegistryEntry {
  id: string;
  mission: OrchestratorMissionState;
  createdAt: number;
  archivedAt: number | null;
}

const registryMutationLocks = new Map<string, Promise<void>>();

function parseMissionState(json: string | null): OrchestratorMissionState | null {
  if (!json) return null;
  try {
    return normalizeOrchestratorMissionState(JSON.parse(json));
  } catch {
    return null;
  }
}

function archiveRegistryRowUnlocked(id: string) {
  const now = Date.now();
  getSqlite().prepare(`
    UPDATE missions SET archived_at = ?, updated_at = ?
     WHERE id = ? AND archived_at IS NULL
  `).run(now, now, id);
}

function queueArchiveRegistryRow(id: string) {
  const missionId = id.trim();
  if (!missionId) return;
  void withRegistryMutationLock(missionId, async () => {
    archiveRegistryRowUnlocked(missionId);
  }).catch((error) => {
    console.warn(`[mission-registry] Failed to archive ${missionId}: ${error instanceof Error ? error.message : String(error)}`);
  });
}

function packetIsActive(packet: OrchestratorPacket) {
  if (packet.archivedAt || packet.releaseState === 'released') return false;
  if (packet.status === 'failed' || packet.status === 'released' || packet.status === 'archived') return false;
  if (packet.queueState === 'queued' || packet.queueState === 'held') return true;
  return packet.status === 'launching'
    || packet.status === 'running'
    || packet.status === 'recovering'
    || packet.status === 'awaiting_review';
}

export function missionHasPendingHeadlessWork(state: OrchestratorMissionState) {
  return state.packets.some((packet) => {
    if (!packetIsActive(packet)) return false;
    return packet.queueState === 'queued'
      || packet.status === 'queued'
      || packet.status === 'launching'
      || packet.status === 'running'
      || packet.status === 'recovering';
  });
}

export function missionIsTerminal(state: OrchestratorMissionState) {
  return state.packets.length > 0 && state.packets.every((packet) => !packetIsActive(packet));
}

function missionRegistryEntryFromRow(row: MissionStateRow): MissionRegistryEntry | null {
  const mission = parseMissionState(row.mission_state_json);
  return mission ? { id: row.id, mission, createdAt: row.created_at, archivedAt: row.archived_at } : null;
}

export function readMissionRegistryEntry(
  missionId: string,
  options: { includeArchived?: boolean } = {},
): MissionRegistryEntry | null {
  const normalizedId = missionId.trim();
  if (!normalizedId) return null;
  const row = getSqlite().prepare(`
    SELECT id, mission_state_json, created_at, archived_at
      FROM missions
     WHERE id = ?
       ${options.includeArchived ? '' : 'AND archived_at IS NULL'}
  `).get(normalizedId) as MissionStateRow | undefined;
  return row ? missionRegistryEntryFromRow(row) : null;
}

export function listMissionRegistryEntries(
  options: { includeArchived?: boolean; excludeMissionId?: string | null } = {},
): MissionRegistryEntry[] {
  const rows = getSqlite().prepare(`
    SELECT id, mission_state_json, created_at, archived_at
      FROM missions
     WHERE ${options.includeArchived ? '1 = 1' : 'archived_at IS NULL'}
     ORDER BY created_at ASC
  `).all() as MissionStateRow[];

  const entries: MissionRegistryEntry[] = [];
  const excludeMissionId = options.excludeMissionId?.trim() ?? '';
  for (const row of rows) {
    if (excludeMissionId && row.id === excludeMissionId) continue;
    const entry = missionRegistryEntryFromRow(row);
    if (!entry) continue;
    entries.push(entry);
  }
  return entries;
}

export function listActiveMissionRegistryEntries(currentMissionId?: string | null): MissionRegistryEntry[] {
  const rows = getSqlite().prepare(`
    SELECT id, mission_state_json, created_at, archived_at
      FROM missions
     WHERE archived_at IS NULL
     ORDER BY created_at ASC
  `).all() as MissionStateRow[];

  const entries: MissionRegistryEntry[] = [];
  const excludeMissionId = currentMissionId?.trim() ?? '';
  for (const row of rows) {
    if (excludeMissionId && row.id === excludeMissionId) continue;
    const entry = missionRegistryEntryFromRow(row);
    if (!entry || missionIsTerminal(entry.mission)) {
      queueArchiveRegistryRow(row.id);
      continue;
    }
    entries.push(entry);
  }
  return entries;
}

export function findMissionRegistryEntryByPacketId(
  packetId: string,
  options: { includeArchived?: boolean; excludeMissionId?: string | null } = {},
): MissionRegistryEntry | null {
  const normalizedPacketId = packetId.trim();
  if (!normalizedPacketId) return null;
  return listMissionRegistryEntries(options)
    .find((entry) => entry.mission.packets.some((packet) => packet.id === normalizedPacketId)) ?? null;
}

export function hasRegistryPendingHeadlessWork(currentMissionId?: string | null) {
  return listActiveMissionRegistryEntries(currentMissionId)
    .some((entry) => missionHasPendingHeadlessWork(entry.mission));
}

function writeMissionRegistryStateUnlocked(state: OrchestratorMissionState): OrchestratorMissionState | null {
  const missionId = state.missionId?.trim();
  if (!missionId) return null;
  const normalized = normalizeOrchestratorMissionState(state);
  const waves = buildDependencyGraph(normalized.packets).map((node) => node.wave);
  const archivedAt = missionIsTerminal(normalized) ? Date.now() : null;
  const now = Date.now();
  const write = getSqlite().transaction(() => {
    getSqlite().prepare(`
      UPDATE missions
         SET prompt = ?, summary = ?, constraints = ?, packet_meta_json = ?,
             mission_state_json = ?, total_waves = ?, updated_at = ?, archived_at = ?
       WHERE id = ?
    `).run(
      normalized.prompt,
      normalized.summary,
      normalized.constraints,
      JSON.stringify(normalized.packets.map((packet) => ({
        id: packet.id,
        title: packet.title,
        referenceLabel: packet.referenceLabel,
      }))),
      JSON.stringify(normalized),
      Math.max(1, ...waves),
      now,
      archivedAt,
      missionId,
    );
  });
  write();
  return normalized;
}

async function withRegistryMutationLock<T>(missionId: string, fn: () => Promise<T>): Promise<T> {
  const key = missionId.trim();
  const previous = registryMutationLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.catch(() => {}).then(() => lock);
  registryMutationLocks.set(key, chained);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (registryMutationLocks.get(key) === chained) {
      registryMutationLocks.delete(key);
    }
  }
}

export async function withMissionRegistryState<T>(
  missionId: string,
  updater: (state: OrchestratorMissionState) => Promise<{ state: OrchestratorMissionState; result: T }> | { state: OrchestratorMissionState; result: T },
): Promise<{ state: OrchestratorMissionState; result: T }> {
  const normalizedId = missionId.trim();
  if (!normalizedId) {
    throw new Error('missionId is required.');
  }

  return withRegistryMutationLock(normalizedId, async () => {
    const entry = readMissionRegistryEntry(normalizedId, { includeArchived: true });
    if (!entry) {
      throw new Error(`Mission ${normalizedId} not found.`);
    }
    const next = await updater(entry.mission);
    const persisted = writeMissionRegistryStateUnlocked({
      ...next.state,
      missionId: normalizedId,
    });
    if (!persisted) {
      throw new Error(`Mission ${normalizedId} could not be persisted.`);
    }
    return { result: next.result, state: persisted };
  });
}

export async function persistMissionRegistryState(state: OrchestratorMissionState): Promise<OrchestratorMissionState | null> {
  const missionId = state.missionId?.trim();
  if (!missionId) return null;
  return withRegistryMutationLock(missionId, async () => writeMissionRegistryStateUnlocked(state));
}
