import 'server-only';

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import type Database from 'better-sqlite3';

import { getSqlite } from '@/lib/db';
import { ensureV45BroadcastFocusSchema } from '@/lib/db/v45-broadcast-focus-migration';
import type { AgentMessage, AgentMessageRefs, AgentPresence } from './types';

export type { AgentMessage, AgentMessageRefs, AgentPresence } from './types';

export const AGENT_MESSAGE_TEXT_MAX_LENGTH = 4_000;
export const AGENT_PRESENCE_TTL_MS = 6 * 60_000;

interface PresenceRow {
  agent_id: string;
  name: string;
  repo_path: string;
  worktree_path: string | null;
  runtime: string;
  session_key: string | null;
  lane_id: string | null;
  packet_id: string | null;
  last_seen: string;
}

interface MessageRow {
  sequence: number;
  id: string;
  from_agent: string;
  to_agent: string;
  repo_path: string;
  text: string;
  refs_json: string;
  delivery_status: 'native' | 'poll' | 'failed';
  delivery_note: string | null;
  created_at: string;
}

function normalizeRepoPath(repo: string): string {
  return resolve(repo).replace(/\/+$/, '');
}

function expandBroadcastTextLimit(sqlite: Database.Database): void {
  const row = sqlite.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'broadcast_events'
  `).get() as { sql: string | null } | undefined;
  const original = row?.sql ?? '';
  if (!original.includes('BETWEEN 1 AND 2000')) return;
  const replacement = original
    .replace(/CREATE TABLE\s+["`\[]?broadcast_events["`\]]?/i, 'CREATE TABLE broadcast_events_agent_bus')
    .replace('BETWEEN 1 AND 2000', 'BETWEEN 1 AND 4000');
  sqlite.transaction(() => {
    sqlite.exec(replacement);
    sqlite.exec(`
      INSERT INTO broadcast_events_agent_bus
        (sequence, id, kind, actor, audience, text, lane_id, packet_id, metadata_json, created_at)
      SELECT sequence, id, kind, actor, audience, text, lane_id, packet_id, metadata_json, created_at
      FROM broadcast_events;
      DROP TABLE broadcast_events;
      ALTER TABLE broadcast_events_agent_bus RENAME TO broadcast_events;
      CREATE INDEX idx_broadcast_events_kind_created ON broadcast_events(kind, created_at);
    `);
  })();
}

export function ensureAgentBusSchema(sqlite: Database.Database = getSqlite()): void {
  ensureV45BroadcastFocusSchema(sqlite);
  expandBroadcastTextLimit(sqlite);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agent_presence (
      agent_id TEXT PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE,
      repo_path TEXT NOT NULL,
      worktree_path TEXT,
      runtime TEXT NOT NULL,
      session_key TEXT,
      lane_id TEXT,
      packet_id TEXT,
      last_seen TEXT NOT NULL,
      UNIQUE(repo_path, name)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_presence_repo_seen
      ON agent_presence(repo_path, last_seen);
    CREATE INDEX IF NOT EXISTS idx_agent_presence_packet
      ON agent_presence(packet_id);

    CREATE TABLE IF NOT EXISTS agent_messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
      refs_json TEXT NOT NULL DEFAULT '{}',
      delivery_status TEXT NOT NULL CHECK (delivery_status IN ('native', 'poll', 'failed')),
      delivery_note TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_messages_inbox
      ON agent_messages(repo_path, to_agent, sequence);
  `);
}

function mapPresence(row: PresenceRow): AgentPresence {
  return {
    agentId: row.agent_id,
    name: row.name,
    repo: row.repo_path,
    worktreePath: row.worktree_path,
    runtime: row.runtime,
    sessionKey: row.session_key,
    laneId: row.lane_id,
    packetId: row.packet_id,
    lastSeen: row.last_seen,
  };
}

function parseRefs(value: string): AgentMessageRefs {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      laneId: typeof parsed.laneId === 'string' ? parsed.laneId : null,
      packetId: typeof parsed.packetId === 'string' ? parsed.packetId : null,
    };
  } catch {
    return { laneId: null, packetId: null };
  }
}

function mapMessage(row: MessageRow): AgentMessage {
  return {
    schema: 'o8/agents.message-event/v1',
    kind: 'message',
    sequence: row.sequence,
    id: row.id,
    from: row.from_agent,
    to: row.to_agent,
    repo: row.repo_path,
    text: row.text,
    refs: parseRefs(row.refs_json),
    delivery: row.delivery_status,
    deliveryNote: row.delivery_note,
    timestamp: row.created_at,
  };
}

export function upsertAgentPresence(
  input: Omit<AgentPresence, 'repo'> & { repo: string },
  sqlite: Database.Database = getSqlite(),
): AgentPresence {
  ensureAgentBusSchema(sqlite);
  const repo = normalizeRepoPath(input.repo);
  sqlite.prepare(`
    INSERT INTO agent_presence
      (agent_id, name, repo_path, worktree_path, runtime, session_key, lane_id, packet_id, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      name = excluded.name,
      repo_path = excluded.repo_path,
      worktree_path = excluded.worktree_path,
      runtime = excluded.runtime,
      session_key = excluded.session_key,
      lane_id = excluded.lane_id,
      packet_id = excluded.packet_id,
      last_seen = excluded.last_seen
  `).run(
    input.agentId,
    input.name,
    repo,
    input.worktreePath,
    input.runtime,
    input.sessionKey,
    input.laneId,
    input.packetId,
    input.lastSeen,
  );
  return { ...input, repo };
}

export function findAgentPresence(
  input: { agentId?: string | null; name?: string | null; repo?: string | null },
  sqlite: Database.Database = getSqlite(),
): AgentPresence | null {
  ensureAgentBusSchema(sqlite);
  const repo = input.repo ? normalizeRepoPath(input.repo) : null;
  let row: PresenceRow | undefined;
  if (input.agentId) {
    row = sqlite.prepare('SELECT * FROM agent_presence WHERE agent_id = ?')
      .get(input.agentId) as PresenceRow | undefined;
  } else if (input.name && repo) {
    row = sqlite.prepare('SELECT * FROM agent_presence WHERE repo_path = ? AND name = ? COLLATE NOCASE')
      .get(repo, input.name) as PresenceRow | undefined;
  } else if (input.name) {
    const rows = sqlite.prepare('SELECT * FROM agent_presence WHERE name = ? COLLATE NOCASE ORDER BY last_seen DESC')
      .all(input.name) as PresenceRow[];
    if (rows.length === 1) row = rows[0];
  }
  return row ? mapPresence(row) : null;
}

export function listAgentPresence(
  repo: string,
  options: { now?: Date; includeStale?: boolean } = {},
  sqlite: Database.Database = getSqlite(),
): AgentPresence[] {
  ensureAgentBusSchema(sqlite);
  const normalizedRepo = normalizeRepoPath(repo);
  const rows = sqlite.prepare(`
    SELECT * FROM agent_presence WHERE repo_path = ? ORDER BY last_seen DESC, name ASC
  `).all(normalizedRepo) as PresenceRow[];
  if (options.includeStale) return rows.map(mapPresence);
  const cutoff = (options.now ?? new Date()).getTime() - AGENT_PRESENCE_TTL_MS;
  return rows.filter((row) => Date.parse(row.last_seen) >= cutoff).map(mapPresence);
}

export function isPresenceLive(presence: AgentPresence, now = Date.now()): boolean {
  const seen = Date.parse(presence.lastSeen);
  return Number.isFinite(seen) && now - seen <= AGENT_PRESENCE_TTL_MS;
}

export function persistAgentMessage(
  input: {
    from: string;
    to: string;
    repo: string;
    text: string;
    refs: AgentMessageRefs;
  },
  sqlite: Database.Database = getSqlite(),
): AgentMessage {
  ensureAgentBusSchema(sqlite);
  const timestamp = new Date().toISOString();
  const id = `message-${randomUUID()}`;
  const repo = normalizeRepoPath(input.repo);
  sqlite.transaction(() => {
    sqlite.prepare(`
      INSERT INTO agent_messages
        (id, from_agent, to_agent, repo_path, text, refs_json, delivery_status, delivery_note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'poll', NULL, ?)
    `).run(id, input.from, input.to, repo, input.text, JSON.stringify(input.refs), timestamp);
    sqlite.prepare(`
      INSERT INTO broadcast_events
        (id, kind, actor, audience, text, lane_id, packet_id, metadata_json, created_at)
      VALUES (?, 'conversation', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `broadcast-${randomUUID()}`,
      input.from,
      input.to,
      input.text,
      input.refs.laneId,
      input.refs.packetId,
      JSON.stringify({ agentMessageId: id, repoPath: repo, from: input.from, to: input.to, refs: input.refs }),
      timestamp,
    );
  })();
  const row = sqlite.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id) as MessageRow;
  return mapMessage(row);
}

export function updateAgentMessageDelivery(
  id: string,
  delivery: AgentMessage['delivery'],
  note: string | null,
  sqlite: Database.Database = getSqlite(),
): AgentMessage {
  sqlite.prepare(`
    UPDATE agent_messages SET delivery_status = ?, delivery_note = ? WHERE id = ?
  `).run(delivery, note, id);
  return mapMessage(sqlite.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id) as MessageRow);
}

export function listAgentInbox(
  input: { agent: AgentPresence; after: number; limit: number },
  sqlite: Database.Database = getSqlite(),
): { messages: AgentMessage[]; cursor: number; hasMore: boolean } {
  ensureAgentBusSchema(sqlite);
  const rows = sqlite.prepare(`
    SELECT * FROM agent_messages
    WHERE repo_path = ? AND to_agent = ? COLLATE NOCASE AND sequence > ?
    ORDER BY sequence ASC LIMIT ?
  `).all(input.agent.repo, input.agent.name, input.after, input.limit + 1) as MessageRow[];
  const hasMore = rows.length > input.limit;
  const messages = rows.slice(0, input.limit).map(mapMessage);
  return {
    messages,
    cursor: messages.at(-1)?.sequence ?? input.after,
    hasMore,
  };
}

export function listRecentAgentMessages(
  repo: string,
  limit: number,
  sqlite: Database.Database = getSqlite(),
): AgentMessage[] {
  ensureAgentBusSchema(sqlite);
  const rows = sqlite.prepare(`
    SELECT * FROM agent_messages
    WHERE repo_path = ?
    ORDER BY sequence DESC LIMIT ?
  `).all(normalizeRepoPath(repo), limit) as MessageRow[];
  return rows.map(mapMessage);
}
