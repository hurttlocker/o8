import 'server-only';

import { getSqlite } from '@/lib/db';
import { buildDependencyGraph } from '@/lib/orchestrator/dag';
import { normalizeOrchestratorMissionState } from '@/lib/orchestrator/store';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

interface MissionStateRow {
  id: string;
  mission_state_json: string | null;
  created_at: number;
}

export interface MissionRegistryEntry {
  id: string;
  mission: OrchestratorMissionState;
  createdAt: number;
}

function parseMissionState(json: string | null): OrchestratorMissionState | null {
  if (!json) return null;
  try {
    return normalizeOrchestratorMissionState(JSON.parse(json));
  } catch {
    return null;
  }
}

function archiveRegistryRow(id: string) {
  const now = Date.now();
  getSqlite().prepare(`
    UPDATE missions SET archived_at = ?, updated_at = ?
     WHERE id = ? AND archived_at IS NULL
  `).run(now, now, id);
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

export function listActiveMissionRegistryEntries(currentMissionId?: string | null): MissionRegistryEntry[] {
  const rows = getSqlite().prepare(`
    SELECT id, mission_state_json, created_at
      FROM missions
     WHERE archived_at IS NULL
     ORDER BY created_at ASC
  `).all() as MissionStateRow[];

  const entries: MissionRegistryEntry[] = [];
  for (const row of rows) {
    if (row.id === currentMissionId) continue;
    const mission = parseMissionState(row.mission_state_json);
    if (!mission || missionIsTerminal(mission)) {
      archiveRegistryRow(row.id);
      continue;
    }
    entries.push({ id: row.id, mission, createdAt: row.created_at });
  }
  return entries;
}

export function hasRegistryPendingHeadlessWork(currentMissionId?: string | null) {
  return listActiveMissionRegistryEntries(currentMissionId)
    .some((entry) => missionHasPendingHeadlessWork(entry.mission));
}

export function persistMissionRegistryState(state: OrchestratorMissionState): void {
  const missionId = state.missionId?.trim();
  if (!missionId) return;
  const normalized = normalizeOrchestratorMissionState(state);
  const waves = buildDependencyGraph(normalized.packets).map((node) => node.wave);
  const archivedAt = missionIsTerminal(normalized) ? Date.now() : null;
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
    Date.now(),
    archivedAt,
    missionId,
  );
}
