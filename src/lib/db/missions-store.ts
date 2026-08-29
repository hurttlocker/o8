/**
 * Missions registry — historical archive of every dispatched mission so
 * `get_mission_status(missionId)` can serve parallel-mission queries.
 *
 * The orchestrator's single-mission file at ~/.o8/orchestrator-state.json
 * still owns the "active" mission lifecycle (dispatch tick, submit_review,
 * approve_and_merge, reset, retry). This table is a sibling archive: every
 * createMission call inserts here, and getMissionStatus falls back to here
 * when the requested missionId isn't the current one.
 *
 * Packet status for historical missions is reconstructed by joining
 * packet_ids_json against the live `lanes` table — lanes are mission-
 * agnostic and persist beyond the file flip-over.
 */

import 'server-only';
import { getSqlite } from '@/lib/db';
import { normalizeOrchestratorMissionState } from '@/lib/orchestrator/store';
import { normalizeOrchestratorMissionStateForPersistence } from '@/lib/orchestrator/persisted-mission';
import type { OrchestratorMissionState } from '@/lib/orchestrator/types';

export interface MissionPacketMeta {
  id: string;
  title: string;
  referenceLabel: string;
}

export interface MissionRecord {
  id: string;
  repoPath: string;
  runtime: string;
  prompt: string;
  summary: string;
  constraints: string;
  packetMeta: MissionPacketMeta[];
  missionState: OrchestratorMissionState | null;
  totalWaves: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface RecordMissionInput {
  id: string;
  repoPath: string;
  runtime: string;
  prompt: string;
  summary: string;
  constraints: string;
  packetMeta: MissionPacketMeta[];
  missionState?: OrchestratorMissionState | null;
  totalWaves: number;
}

function parsePacketMeta(json: string): MissionPacketMeta[] {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((row): row is MissionPacketMeta =>
        row && typeof row === 'object'
        && typeof row.id === 'string'
        && typeof row.title === 'string'
        && typeof row.referenceLabel === 'string',
      );
  } catch {
    return [];
  }
}

function parseMissionState(json: string | null): OrchestratorMissionState | null {
  if (!json) return null;
  try {
    return normalizeOrchestratorMissionState(JSON.parse(json));
  } catch {
    return null;
  }
}

interface MissionRow {
  id: string;
  repo_path: string;
  runtime: string;
  prompt: string;
  summary: string;
  constraints: string;
  packet_meta_json: string;
  mission_state_json: string | null;
  total_waves: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

function rowToRecord(row: MissionRow): MissionRecord {
  return {
    id: row.id,
    repoPath: row.repo_path,
    runtime: row.runtime,
    prompt: row.prompt,
    summary: row.summary,
    constraints: row.constraints,
    packetMeta: parsePacketMeta(row.packet_meta_json),
    missionState: parseMissionState(row.mission_state_json),
    totalWaves: row.total_waves,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

/**
 * Insert (or replace) a mission record. Called from `createMission` after the
 * file-based control plane finishes its write. Idempotent on id.
 */
export function recordMission(input: RecordMissionInput): void {
  const db = getSqlite();
  const now = Date.now();
  db.prepare(`
    INSERT INTO missions (
      id, repo_path, runtime, prompt, summary, constraints,
      packet_meta_json, mission_state_json, total_waves, created_at, updated_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(id) DO UPDATE SET
      repo_path = excluded.repo_path,
      runtime = excluded.runtime,
      prompt = excluded.prompt,
      summary = excluded.summary,
      constraints = excluded.constraints,
      packet_meta_json = excluded.packet_meta_json,
      mission_state_json = excluded.mission_state_json,
      total_waves = excluded.total_waves,
      updated_at = excluded.updated_at,
      archived_at = NULL
  `).run(
    input.id,
    input.repoPath,
    input.runtime,
    input.prompt,
    input.summary,
    input.constraints,
    JSON.stringify(input.packetMeta),
    JSON.stringify(input.missionState
      ? normalizeOrchestratorMissionStateForPersistence(input.missionState)
      : null),
    input.totalWaves,
    now,
    now,
  );
}

/**
 * Historical rows without a packet-bearing snapshot are not dispatchable. Keep
 * active snapshots live even when a newer mission becomes the UI focus.
 */
export function archiveMissionsExcept(currentId: string): void {
  const db = getSqlite();
  const now = Date.now();
  db.prepare(`
    UPDATE missions
       SET archived_at = ?, updated_at = ?
     WHERE id != ?
       AND archived_at IS NULL
       AND (mission_state_json IS NULL OR mission_state_json = '')
  `).run(now, now, currentId);
}

export function getMissionRecord(id: string): MissionRecord | null {
  const db = getSqlite();
  const row = db.prepare(`SELECT * FROM missions WHERE id = ?`).get(id) as MissionRow | undefined;
  return row ? rowToRecord(row) : null;
}

/**
 * Newest first. Useful for a future `list_missions` MCP tool or an Activity
 * panel that wants to show "your recent missions."
 */
export function listRecentMissions(limit = 20): MissionRecord[] {
  const db = getSqlite();
  const rows = db.prepare(`SELECT * FROM missions ORDER BY created_at DESC LIMIT ?`).all(limit) as MissionRow[];
  return rows.map(rowToRecord);
}
