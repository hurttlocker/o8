import 'server-only';

import path from 'node:path';

import type Database from 'better-sqlite3';

import { getSqlite } from '@/lib/db';
import { listActiveLanes } from '@/lib/lane/registry';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { listRecentBroadcastEvents } from './events';
import { redactBroadcastText } from './redaction';
import type {
  BroadcastApprovalSnapshot,
  BroadcastSnapshot,
} from './types';

const ACTIVE_AGENT_STATUSES = new Set([
  'launching',
  'running',
  'awaiting_input',
  'awaiting_orchestrator',
  'recovering',
  'reviewing',
  'merging',
]);

interface PendingApprovalRow {
  id: string;
  lane_id: string | null;
  packet_id: string | null;
  title: string;
  risk: string;
  created_at: number;
}

function repoLabel(repoPath: string): string {
  const normalized = repoPath.replace(/[\\/]+$/, '');
  return path.basename(normalized) || 'repository';
}

function pendingApprovals(sqlite: Database.Database): BroadcastApprovalSnapshot[] {
  return (sqlite.prepare(`
    SELECT id, lane_id, packet_id, title, risk, created_at
    FROM approvals
    WHERE status = 'pending'
    ORDER BY created_at ASC, id ASC
  `).all() as PendingApprovalRow[]).map((row) => ({
    id: row.id,
    laneId: row.lane_id,
    packetId: row.packet_id,
    title: redactBroadcastText(row.title),
    risk: row.risk,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

export function buildBroadcastSnapshot(
  recentEventLimit = 30,
  sqlite: Database.Database = getSqlite(),
): BroadcastSnapshot {
  const lanes = listActiveLanes();
  const mission = readOrchestratorControlPlaneState();
  const approvals = pendingApprovals(sqlite);
  const recent = listRecentBroadcastEvents({ limit: recentEventLimit }, sqlite);
  return {
    schema: 'o8/broadcast.snapshot/v1',
    generatedAt: new Date().toISOString(),
    lanes: lanes.map((lane) => ({
      id: lane.id,
      packetId: lane.packetId,
      repo: repoLabel(lane.repoPath),
      label: redactBroadcastText(lane.label),
      runtime: lane.runtime,
      status: lane.status,
      lastEventAt: lane.lastEventAt,
      lastEventLabel: lane.lastEventLabel,
    })),
    packets: mission.packets.map((packet) => ({
      id: packet.id,
      title: redactBroadcastText(packet.title),
      status: packet.status,
      queueState: packet.queueState,
      releaseState: packet.releaseState,
      laneId: packet.lane?.laneId ?? null,
    })),
    activeAgents: lanes
      .filter((lane) => Boolean(lane.sessionKey) && ACTIVE_AGENT_STATUSES.has(lane.status))
      .map((lane) => ({
        laneId: lane.id,
        packetId: lane.packetId,
        label: redactBroadcastText(lane.label),
        repo: repoLabel(lane.repoPath),
        runtime: lane.runtime,
        status: lane.status,
        startedAt: lane.createdAt,
      })),
    pendingApprovals: {
      count: approvals.length,
      items: approvals,
    },
    recentEvents: recent.events,
    cursor: recent.cursor,
  };
}
