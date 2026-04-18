import { randomUUID } from 'node:crypto';
import { getSqlite } from '@/lib/db';
import { listLanes } from '@/lib/lane/registry';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';

export type SupervisorInboxKind =
  | 'verification_failed'
  | 'session_lost'
  | 'packet_missing'
  | 'bounded_retry_exhausted'
  | 'merge_blocked'
  | 'fetch_unreachable';

export type SupervisorInboxStatus =
  | 'pending'
  | 'self_healed'
  | 'human_required'
  | 'dismissed';

export interface SupervisorInboxPayload {
  [key: string]: unknown;
}

export interface EnqueueInboxItemInput {
  repoPath: string;
  packetId?: string | null;
  kind: SupervisorInboxKind;
  payload: SupervisorInboxPayload;
  status?: SupervisorInboxStatus;
}

interface SupervisorInboxRow {
  id: string;
  repo_path: string;
  packet_id: string | null;
  kind: SupervisorInboxKind;
  payload: string;
  created_at: string;
  status: SupervisorInboxStatus;
  resolved_at: string | null;
}

export interface SupervisorInboxItem {
  id: string;
  repoPath: string;
  packetId: string | null;
  kind: SupervisorInboxKind;
  payload: SupervisorInboxPayload;
  createdAt: string;
  status: SupervisorInboxStatus;
  resolvedAt: string | null;
  packetTitle: string | null;
  packetReferenceLabel: string | null;
  sessionKey: string | null;
  worktreePath: string | null;
  transcriptLink: string | null;
  worktreeLink: string | null;
  errorExcerpt: string;
}

let supervisorInboxReady = false;

function ensureSupervisorInboxTable() {
  if (supervisorInboxReady) {
    return;
  }

  const sqlite = getSqlite();
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS supervisor_inbox (
      id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      packet_id TEXT,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'pending',
      resolved_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_supervisor_inbox_status_created
      ON supervisor_inbox(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_supervisor_inbox_repo_path_created
      ON supervisor_inbox(repo_path, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_supervisor_inbox_packet_id
      ON supervisor_inbox(packet_id);
  `);

  supervisorInboxReady = true;
}

function parsePayload(raw: string): SupervisorInboxPayload {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as SupervisorInboxPayload;
    }
  } catch {
    // Preserve inbox reads even if a row contains malformed payload JSON.
  }
  return {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function firstMeaningfulLine(text: string | null): string {
  if (!text) {
    return 'Operator review required.';
  }

  const line = text
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate && candidate !== '```');

  return line ?? 'Operator review required.';
}

function statusRank(status: SupervisorInboxStatus): number {
  switch (status) {
    case 'human_required':
      return 0;
    case 'pending':
      return 1;
    case 'self_healed':
      return 2;
    case 'dismissed':
      return 3;
    default:
      return 4;
  }
}

export function enqueueInboxItem(input: EnqueueInboxItemInput) {
  ensureSupervisorInboxTable();

  const sqlite = getSqlite();
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const status = input.status ?? 'human_required';

  sqlite.prepare(`
    INSERT INTO supervisor_inbox (
      id,
      repo_path,
      packet_id,
      kind,
      payload,
      created_at,
      status,
      resolved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    id,
    input.repoPath,
    input.packetId ?? null,
    input.kind,
    JSON.stringify(input.payload),
    createdAt,
    status,
  );

  return {
    id,
    repoPath: input.repoPath,
    packetId: input.packetId ?? null,
    kind: input.kind,
    payload: input.payload,
    createdAt,
    status,
    resolvedAt: null,
  };
}

export function countInboxItems(status: SupervisorInboxStatus = 'human_required'): number {
  ensureSupervisorInboxTable();

  const row = getSqlite()
    .prepare('SELECT COUNT(*) AS count FROM supervisor_inbox WHERE status = ?')
    .get(status) as { count?: number } | undefined;

  return row?.count ?? 0;
}

export function dismissInboxItem(id: string) {
  ensureSupervisorInboxTable();

  getSqlite().prepare(`
    UPDATE supervisor_inbox
    SET status = ?, resolved_at = ?
    WHERE id = ?
  `).run('dismissed', new Date().toISOString(), id);
}

export function listInboxItems(options: { includeDismissed?: boolean } = {}): SupervisorInboxItem[] {
  ensureSupervisorInboxTable();

  const rows = getSqlite().prepare(`
    SELECT id, repo_path, packet_id, kind, payload, created_at, status, resolved_at
    FROM supervisor_inbox
    ${options.includeDismissed ? '' : `WHERE status != 'dismissed'`}
    ORDER BY created_at DESC
  `).all() as SupervisorInboxRow[];

  const lanes = listLanes();
  const laneByPacketId = new Map(lanes.flatMap((lane) => (
    lane.packetId ? [[lane.packetId, lane] as const] : []
  )));
  const laneByRepoPath = new Map<string, (typeof lanes)[number]>();
  for (const lane of lanes) {
    if (laneByRepoPath.has(lane.repoPath)) {
      continue;
    }
    laneByRepoPath.set(lane.repoPath, lane);
  }

  const state = readOrchestratorControlPlaneState();
  const packetById = new Map(state.packets.map((packet) => [packet.id, packet] as const));

  return rows
    .map((row) => {
      const payload = parsePayload(row.payload);
      const packet = row.packet_id ? packetById.get(row.packet_id) ?? null : null;
      const lane = (row.packet_id ? laneByPacketId.get(row.packet_id) ?? null : null)
        ?? laneByRepoPath.get(row.repo_path)
        ?? null;

      const packetTitle = stringValue(payload.packetTitle)
        ?? packet?.title
        ?? stringValue(payload.laneLabel);
      const packetReferenceLabel = stringValue(payload.packetReferenceLabel)
        ?? packet?.referenceLabel
        ?? null;
      const sessionKey = stringValue(payload.sessionKey)
        ?? packet?.lane?.sessionKey
        ?? lane?.sessionKey
        ?? null;
      const worktreePath = stringValue(payload.worktreePath)
        ?? packet?.lane?.worktreePath
        ?? lane?.worktreePath
        ?? row.repo_path;

      const errorExcerpt = firstMeaningfulLine(
        stringValue(payload.errorExcerpt)
        ?? stringValue(payload.errorMessage)
        ?? stringValue(payload.retryHandoffError)
        ?? stringValue(payload.summary)
        ?? stringValue(payload.verificationOutput),
      );

      return {
        id: row.id,
        repoPath: row.repo_path,
        packetId: row.packet_id,
        kind: row.kind,
        payload,
        createdAt: row.created_at,
        status: row.status,
        resolvedAt: row.resolved_at,
        packetTitle,
        packetReferenceLabel,
        sessionKey,
        worktreePath,
        transcriptLink: sessionKey
          ? `/api/runtime/transcript?sessionKey=${encodeURIComponent(sessionKey)}&limit=50`
          : null,
        worktreeLink: worktreePath ? `file://${encodeURI(worktreePath)}` : null,
        errorExcerpt,
      } satisfies SupervisorInboxItem;
    })
    .sort((left, right) => {
      const statusDiff = statusRank(left.status) - statusRank(right.status);
      if (statusDiff !== 0) {
        return statusDiff;
      }
      return right.createdAt.localeCompare(left.createdAt);
    });
}
