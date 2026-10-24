import 'server-only';

import type Database from 'better-sqlite3';

import { getSqlite } from '@/lib/db';
import { ensureAgentBusSchema } from './store';
import type { AgentPresence } from './types';

/** Coalesced unread work keeps its wake even if the original message was read. */
export function isAgentInboxWakePending(
  agent: AgentPresence,
  reservationId: string,
  sqlite: Database.Database = getSqlite(),
): boolean {
  ensureAgentBusSchema(sqlite);
  if (!agent.sessionKey || !reservationId) return false;
  return Boolean(sqlite.prepare(`
    SELECT 1 FROM agent_inbox_state
    WHERE repo_path = ? AND agent_name = ? COLLATE NOCASE
      AND native_wake_session_key = ? AND native_wake_id = ?
      AND acknowledged_sequence < native_wake_through_sequence
  `).get(agent.repo, agent.name, agent.sessionKey, reservationId));
}
