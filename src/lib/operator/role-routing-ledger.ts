import 'server-only';

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

import { getSqlite } from '@/lib/db';
import type { RoleId, RoleRouteChoice, RoleRouteChoiceSources } from './role-routing';

export type RoleRoutingReceiptStatus = 'selected' | 'fallback' | 'refused' | 'failed';

export interface RoleRoutingReceipt {
  id: string;
  receiptKey: string | null;
  role: RoleId;
  repoPath: string | null;
  contextType: string | null;
  contextId: string | null;
  requested: RoleRouteChoice;
  effective: RoleRouteChoice | null;
  sources: RoleRouteChoiceSources;
  reason: string;
  fallbackReason: string | null;
  status: RoleRoutingReceiptStatus;
  createdAt: string;
}

export interface RecordRoleRoutingReceiptInput {
  receiptKey?: string | null;
  role: RoleId;
  repoPath?: string | null;
  contextType?: string | null;
  contextId?: string | null;
  requested: RoleRouteChoice;
  effective?: RoleRouteChoice | null;
  sources: RoleRouteChoiceSources;
  reason: string;
  fallbackReason?: string | null;
  status: RoleRoutingReceiptStatus;
  createdAt?: string;
}

interface RoleRoutingReceiptRow {
  id: string;
  receipt_key: string | null;
  role: RoleId;
  repo_path: string | null;
  context_type: string | null;
  context_id: string | null;
  requested_json: string;
  effective_json: string | null;
  sources_json: string;
  reason: string;
  fallback_reason: string | null;
  status: RoleRoutingReceiptStatus;
  created_at: string;
}

const UNREADABLE_ROUTE: RoleRouteChoice = {
  backend: null,
  runtime: null,
  model: null,
  effort: null,
  label: 'Unreadable route',
};

export function ensureRoleRoutingLedgerSchema(sqlite: Database.Database = getSqlite()): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS role_routing_receipts (
      id TEXT PRIMARY KEY,
      receipt_key TEXT UNIQUE,
      role TEXT NOT NULL,
      repo_path TEXT,
      context_type TEXT,
      context_id TEXT,
      requested_json TEXT NOT NULL,
      effective_json TEXT,
      sources_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      fallback_reason TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_role_routing_receipts_role_created
      ON role_routing_receipts(role, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_role_routing_receipts_repo_created
      ON role_routing_receipts(repo_path, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_role_routing_receipts_context
      ON role_routing_receipts(context_type, context_id, created_at DESC);
  `);
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToReceipt(row: RoleRoutingReceiptRow): RoleRoutingReceipt {
  return {
    id: row.id,
    receiptKey: row.receipt_key,
    role: row.role,
    repoPath: row.repo_path,
    contextType: row.context_type,
    contextId: row.context_id,
    requested: parseJson(row.requested_json, UNREADABLE_ROUTE),
    effective: row.effective_json ? parseJson(row.effective_json, null) : null,
    sources: parseJson(row.sources_json, {
      backend: 'request-time',
      runtime: 'request-time',
      model: 'request-time',
      effort: 'request-time',
    }),
    reason: row.reason,
    fallbackReason: row.fallback_reason,
    status: row.status,
    createdAt: row.created_at,
  };
}

export function recordRoleRoutingReceipt(
  input: RecordRoleRoutingReceiptInput,
  sqlite: Database.Database = getSqlite(),
): RoleRoutingReceipt {
  ensureRoleRoutingLedgerSchema(sqlite);
  const id = randomUUID();
  const createdAt = input.createdAt ?? new Date().toISOString();
  const receiptKey = input.receiptKey?.trim() || null;
  sqlite.prepare(`
    INSERT INTO role_routing_receipts (
      id, receipt_key, role, repo_path, context_type, context_id,
      requested_json, effective_json, sources_json, reason,
      fallback_reason, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(receipt_key) DO UPDATE SET
      repo_path = excluded.repo_path,
      context_type = excluded.context_type,
      context_id = excluded.context_id,
      requested_json = excluded.requested_json,
      effective_json = excluded.effective_json,
      sources_json = excluded.sources_json,
      reason = excluded.reason,
      fallback_reason = excluded.fallback_reason,
      status = excluded.status,
      created_at = excluded.created_at
  `).run(
    id,
    receiptKey,
    input.role,
    input.repoPath ?? null,
    input.contextType ?? null,
    input.contextId ?? null,
    JSON.stringify(input.requested),
    input.effective ? JSON.stringify(input.effective) : null,
    JSON.stringify(input.sources),
    input.reason,
    input.fallbackReason ?? null,
    input.status,
    createdAt,
  );
  const row = receiptKey
    ? sqlite.prepare('SELECT * FROM role_routing_receipts WHERE receipt_key = ?').get(receiptKey)
    : sqlite.prepare('SELECT * FROM role_routing_receipts WHERE id = ?').get(id);
  if (!row) throw new Error('Role routing receipt was not readable after persistence.');
  return rowToReceipt(row as RoleRoutingReceiptRow);
}

export function listRoleRoutingReceipts(
  options: { role?: RoleId; repoPath?: string; limit?: number } = {},
  sqlite: Database.Database = getSqlite(),
): RoleRoutingReceipt[] {
  ensureRoleRoutingLedgerSchema(sqlite);
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (options.role) {
    clauses.push('role = ?');
    params.push(options.role);
  }
  if (options.repoPath) {
    clauses.push('repo_path = ?');
    params.push(options.repoPath);
  }
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)));
  params.push(limit);
  const rows = sqlite.prepare(`
    SELECT *
    FROM role_routing_receipts
    ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(...params) as RoleRoutingReceiptRow[];
  return rows.map(rowToReceipt);
}

export function recordRoleRoutingReceiptSafely(input: RecordRoleRoutingReceiptInput): void {
  try {
    recordRoleRoutingReceipt(input);
  } catch (error) {
    console.warn('[role-routing] Failed to persist routing receipt:', error instanceof Error ? error.message : error);
  }
}
