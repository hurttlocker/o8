/**
 * Session Ledger — cross-provider operational memory.
 *
 * Records session outcomes from both Codex and Claude Code runtimes.
 * Queries provide precedent context injected into new agent sessions.
 * This is the compounding moat: no single provider sees the full chain.
 */

import { getSqlite } from '@/lib/db';

// ── Types ──

export type SessionOutcome = 'succeeded' | 'failed' | 'partial' | 'interrupted';

export interface SessionOutcomeRecord {
  id: string;
  repoPath: string;
  branch: string | null;
  runtime: 'codex' | 'claude-code';
  sessionKey: string | null;
  laneId: string | null;
  packetId: string | null;
  outcome: SessionOutcome;
  summary: string;
  attempts: number;
  retryHistoryJson: string;
  durationMs: number | null;
  totalTokens: number;
  costUsd: number;
  model: string | null;
  patternsJson: string;
  conflictZonesJson: string;
  changedFilesJson: string;
  reviewApproved: number | null;
  reviewFindingsCount: number;
  transcriptPath: string | null;
  startedAt: string;
  completedAt: string;
  createdAt: string;
}

export interface WriteSessionOutcomeInput {
  repoPath: string;
  branch?: string | null;
  runtime: 'codex' | 'claude-code';
  sessionKey?: string | null;
  laneId?: string | null;
  packetId?: string | null;
  outcome: SessionOutcome;
  summary: string;
  attempts?: number;
  retryHistory?: unknown[];
  durationMs?: number | null;
  totalTokens?: number;
  costUsd?: number;
  model?: string | null;
  patterns?: string[];
  conflictZones?: string[];
  changedFiles?: string[];
  reviewApproved?: boolean | null;
  reviewFindingsCount?: number;
  transcriptPath?: string | null;
  startedAt: string;
  completedAt: string;
}

export interface LedgerBlock {
  text: string;
  tokenEstimate: number;
  outcomeCount: number;
}

// ── Ensure table ──

let tableEnsured = false;

function ensureTable(): void {
  if (tableEnsured) return;
  const db = getSqlite();
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_outcomes (
      id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      branch TEXT,
      runtime TEXT NOT NULL,
      session_key TEXT,
      lane_id TEXT,
      packet_id TEXT,
      outcome TEXT NOT NULL,
      summary TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 1,
      retry_history_json TEXT NOT NULL DEFAULT '[]',
      duration_ms INTEGER,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      model TEXT,
      patterns_json TEXT NOT NULL DEFAULT '[]',
      conflict_zones_json TEXT NOT NULL DEFAULT '[]',
      changed_files_json TEXT NOT NULL DEFAULT '[]',
      review_approved INTEGER,
      review_findings_count INTEGER NOT NULL DEFAULT 0,
      transcript_path TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_so_repo_runtime ON session_outcomes(repo_path, runtime, completed_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_so_repo_completed ON session_outcomes(repo_path, completed_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_so_lane_id ON session_outcomes(lane_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_so_packet_id ON session_outcomes(packet_id)`);
  tableEnsured = true;
}

// ── Write ──

export function writeSessionOutcome(input: WriteSessionOutcomeInput): string {
  ensureTable();
  const db = getSqlite();
  const id = `so-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(`
    INSERT INTO session_outcomes (
      id, repo_path, branch, runtime, session_key, lane_id, packet_id,
      outcome, summary, attempts, retry_history_json, duration_ms,
      total_tokens, cost_usd, model,
      patterns_json, conflict_zones_json, changed_files_json,
      review_approved, review_findings_count, transcript_path,
      started_at, completed_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?
    )
  `).run(
    id,
    input.repoPath,
    input.branch ?? null,
    input.runtime,
    input.sessionKey ?? null,
    input.laneId ?? null,
    input.packetId ?? null,
    input.outcome,
    input.summary.slice(0, 1200),
    input.attempts ?? 1,
    JSON.stringify(input.retryHistory ?? []),
    input.durationMs ?? null,
    input.totalTokens ?? 0,
    input.costUsd ?? 0,
    input.model ?? null,
    JSON.stringify(input.patterns ?? []),
    JSON.stringify(input.conflictZones ?? []),
    JSON.stringify(input.changedFiles ?? []),
    input.reviewApproved == null ? null : input.reviewApproved ? 1 : 0,
    input.reviewFindingsCount ?? 0,
    input.transcriptPath ?? null,
    input.startedAt,
    input.completedAt,
  );
  return id;
}

// ── Read ──

interface OutcomeRow {
  id: string;
  repo_path: string;
  runtime: string;
  outcome: string;
  summary: string;
  attempts: number;
  model: string | null;
  cost_usd: number;
  total_tokens: number;
  patterns_json: string;
  review_approved: number | null;
  completed_at: string;
}

export function queryRepoLedger(repoPath: string, limit = 5): OutcomeRow[] {
  ensureTable();
  const db = getSqlite();
  return db.prepare(`
    SELECT id, repo_path, runtime, outcome, summary, attempts,
           model, cost_usd, total_tokens, patterns_json, review_approved, completed_at
    FROM session_outcomes
    WHERE repo_path = ?
    ORDER BY completed_at DESC
    LIMIT ?
  `).all(repoPath, limit) as OutcomeRow[];
}

export function queryPacketOutcome(packetId: string): OutcomeRow | null {
  ensureTable();
  const db = getSqlite();
  const row = db.prepare(`
    SELECT id, repo_path, runtime, outcome, summary, attempts,
           model, cost_usd, total_tokens, patterns_json, review_approved, completed_at
    FROM session_outcomes
    WHERE packet_id = ?
    ORDER BY completed_at DESC
    LIMIT 1
  `).get(packetId);
  return (row as OutcomeRow) ?? null;
}

// ── Injection ──

const TOKEN_ESTIMATE_DIVISOR = 4;
const MAX_LEDGER_TOKENS = 800;

function formatOutcome(row: OutcomeRow): string {
  const runtime = row.runtime === 'codex' ? 'Codex' : 'Claude';
  const status = row.outcome === 'succeeded' ? 'completed'
    : row.outcome === 'failed' ? 'FAILED'
    : row.outcome;
  const review = row.review_approved === 1 ? ', approved'
    : row.review_approved === 0 ? ', REJECTED'
    : '';
  const retries = row.attempts > 1 ? `, ${row.attempts} attempts` : '';
  return `- "${row.summary.slice(0, 80)}" (${runtime}) -- ${status}${review}${retries}`;
}

export function buildLedgerBlock(repoPath: string): LedgerBlock {
  const outcomes = queryRepoLedger(repoPath, 5);
  if (outcomes.length === 0) {
    return { text: '', tokenEstimate: 0, outcomeCount: 0 };
  }

  const lines = outcomes.map(formatOutcome);
  const charBudget = MAX_LEDGER_TOKENS * TOKEN_ESTIMATE_DIVISOR;

  let text = `<o8-session-ledger repo="${repoPath.split('/').pop()}">\nRecent outcomes:\n${lines.join('\n')}\n</o8-session-ledger>`;
  if (text.length > charBudget) {
    text = text.slice(0, charBudget) + '\n</o8-session-ledger>';
  }

  return {
    text,
    tokenEstimate: Math.ceil(text.length / TOKEN_ESTIMATE_DIVISOR),
    outcomeCount: outcomes.length,
  };
}
