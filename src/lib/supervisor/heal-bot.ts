import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import { getSqlite } from '@/lib/db';

const execFileAsync = promisify(execFile);

const HEAL_BOT_TICK_MS = 30_000;
const HEAL_BOT_TIMEOUT_MS = 5 * 60_000;
const COMMAND_MAX_BUFFER = 10 * 1024 * 1024;
const OUTPUT_SNIPPET_LIMIT = 4_000;
const HEAL_BOT_SYSTEM_PROMPT = 'You are a heal-bot. The packet failed verification with the attached error. You have 5 minutes. Either: (a) make the minimal fix, commit it, run `npx tsc --noEmit`, and exit successfully, OR (b) write `GIVE_UP: <one-line reason>` to stdout and exit. Do not invent scope — only fix the specific failure.';
const FIXABLE_KINDS = new Set<SupervisorInboxKind>(['verification_failed', 'bounded_retry_exhausted']);

export type SupervisorInboxKind =
  | 'verification_failed'
  | 'session_lost'
  | 'packet_missing'
  | 'bounded_retry_exhausted'
  | 'merge_blocked';

export type SupervisorInboxStatus =
  | 'pending'
  | 'healing'
  | 'self_healed'
  | 'human_required'
  | 'dismissed';

export interface SupervisorInboxPayload {
  laneId?: string | null;
  worktreePath?: string | null;
  sessionKey?: string | null;
  surfaceId?: string | null;
  baseBranch?: string | null;
  packetTitle?: string | null;
  packetReferenceLabel?: string | null;
  verificationKind?: string | null;
  attempts?: string | null;
  error?: string | null;
  diffStat?: string | null;
  lastCommit?: string | null;
  transcriptTail?: string | null;
  note?: string | null;
  retryError?: string | null;
  healBot?: {
    attemptedAt?: string;
    completedAt?: string;
    outcome?: 'success' | 'give_up' | 'failed';
    giveUpReason?: string;
    commitSha?: string;
    commitSubject?: string;
    stdoutSnippet?: string;
    stderrSnippet?: string;
    typecheckOutput?: string;
  };
}

interface SupervisorInboxItem {
  id: string;
  repo_path: string;
  packet_id: string | null;
  kind: SupervisorInboxKind;
  payload: string;
  status: SupervisorInboxStatus;
  heal_attempt_count: number;
  created_at: string;
  resolved_at: string | null;
}

export interface EnqueueSupervisorInboxItemInput {
  repoPath: string;
  packetId?: string | null;
  kind: SupervisorInboxKind;
  payload: SupervisorInboxPayload;
}

let healBotTimer: ReturnType<typeof setInterval> | null = null;
let drainInFlight = false;

function getDb() {
  const sqlite = getSqlite();
  ensureSupervisorInboxSchema(sqlite);
  return sqlite;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parsePayload(payload: string): SupervisorInboxPayload {
  try {
    const parsed = JSON.parse(payload);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as SupervisorInboxPayload;
    }
  } catch {
    // Ignore malformed payloads; they should not break healing.
  }
  return {};
}

function serializePayload(payload: SupervisorInboxPayload): string {
  return JSON.stringify(payload);
}

function truncate(value: string | undefined, limit = OUTPUT_SNIPPET_LIMIT): string {
  const normalized = (value ?? '').trim();
  if (!normalized) return '';
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}\n\n... (truncated)`;
}

function quoteBlock(value: string | null | undefined, fallback: string): string {
  const normalized = (value ?? '').trim();
  return normalized ? normalized : fallback;
}

function ensureColumn(
  sqlite: Database.Database,
  tableName: string,
  columnName: string,
  statement: string,
): void {
  const columns = sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === columnName)) {
    return;
  }
  sqlite.exec(statement);
}

function ensureSupervisorInboxSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS supervisor_inbox (
      id TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      packet_id TEXT,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      heal_attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_supervisor_inbox_status_created
      ON supervisor_inbox(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_supervisor_inbox_packet_id
      ON supervisor_inbox(packet_id);
    CREATE INDEX IF NOT EXISTS idx_supervisor_inbox_repo_created
      ON supervisor_inbox(repo_path, created_at);
  `);

  ensureColumn(
    sqlite,
    'supervisor_inbox',
    'heal_attempt_count',
    `ALTER TABLE supervisor_inbox ADD COLUMN heal_attempt_count INTEGER NOT NULL DEFAULT 0`,
  );
}

function parseGiveUpReason(stdout: string, stderr: string): string | null {
  const combined = `${stdout}\n${stderr}`;
  const match = combined.match(/GIVE_UP:\s*(.+)/i);
  return match?.[1]?.trim() || null;
}

async function readHeadSha(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd,
      timeout: 15_000,
      maxBuffer: COMMAND_MAX_BUFFER,
    });
    const head = stdout.trim();
    return head || null;
  } catch {
    return null;
  }
}

async function readHeadSummary(cwd: string): Promise<{ sha: string | null; subject: string | null }> {
  try {
    const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%H%n%s'], {
      cwd,
      timeout: 15_000,
      maxBuffer: COMMAND_MAX_BUFFER,
    });
    const [sha, ...subjectParts] = stdout.trim().split('\n');
    return {
      sha: sha?.trim() || null,
      subject: subjectParts.join(' ').trim() || null,
    };
  } catch {
    return { sha: null, subject: null };
  }
}

async function readGitStatus(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd,
      timeout: 15_000,
      maxBuffer: COMMAND_MAX_BUFFER,
    });
    return stdout.trim();
  } catch {
    return '';
  }
}

function buildHealPrompt(
  item: SupervisorInboxItem,
  payload: SupervisorInboxPayload,
): string {
  return [
    'Heal the specific verification failure below. Do not widen scope.',
    '',
    `Inbox item: ${item.id}`,
    `Kind: ${item.kind}`,
    `Repo: ${item.repo_path}`,
    `Worktree: ${payload.worktreePath ?? item.repo_path}`,
    `Packet: ${payload.packetReferenceLabel ?? item.packet_id ?? 'unknown'}`,
    `Packet title: ${payload.packetTitle ?? 'unknown'}`,
    `Lane: ${payload.laneId ?? 'unknown'}`,
    `Session: ${payload.sessionKey ?? payload.surfaceId ?? 'unknown'}`,
    payload.attempts ? `Attempts: ${payload.attempts}` : '',
    payload.retryError ? `Retry handoff failure: ${payload.retryError}` : '',
    payload.note ? `Note: ${payload.note}` : '',
    '',
    'Verification error:',
    '```',
    quoteBlock(payload.error, 'Unavailable.'),
    '```',
    '',
    'Last commit:',
    '```',
    quoteBlock(payload.lastCommit, 'Unavailable.'),
    '```',
    '',
    'Diff stat:',
    '```',
    quoteBlock(payload.diffStat, 'Unavailable.'),
    '```',
    '',
    'Transcript tail:',
    '```',
    quoteBlock(payload.transcriptTail, 'Unavailable.'),
    '```',
  ].filter(Boolean).join('\n');
}

async function runHealBotClaude(cwd: string, prompt: string) {
  try {
    const { stdout, stderr } = await execFileAsync('claude', [
      '-p',
      '--print',
      '--dangerously-skip-permissions',
      '--append-system-prompt',
      HEAL_BOT_SYSTEM_PROMPT,
      prompt,
    ], {
      cwd,
      timeout: HEAL_BOT_TIMEOUT_MS,
      maxBuffer: COMMAND_MAX_BUFFER,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    return {
      ok: true,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      timedOut: false,
      exitReason: null as string | null,
    };
  } catch (error) {
    const execError = error as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      message?: string;
      signal?: NodeJS.Signals | null;
      killed?: boolean;
      code?: string | number | null;
    };
    const timedOut = execError.signal === 'SIGTERM' && /timed out/i.test(execError.message ?? '');
    return {
      ok: false,
      stdout: bufferToString(execError.stdout).trim(),
      stderr: bufferToString(execError.stderr).trim(),
      timedOut,
      exitReason: timedOut
        ? `heal-bot timed out after ${Math.floor(HEAL_BOT_TIMEOUT_MS / 60_000)} minutes`
        : execError.message?.trim() || (execError.code ? `claude exited with ${String(execError.code)}` : 'claude exited unsuccessfully'),
    };
  }
}

function bufferToString(value?: string | Buffer): string {
  if (typeof value === 'string') return value;
  if (value instanceof Buffer) return value.toString('utf-8');
  return '';
}

function updateInboxItem(
  itemId: string,
  status: SupervisorInboxStatus,
  payload: SupervisorInboxPayload,
  resolvedAt: string | null,
): void {
  getDb().prepare(`
    UPDATE supervisor_inbox
       SET status = ?,
           payload = ?,
           resolved_at = ?
     WHERE id = ?
  `).run(status, serializePayload(payload), resolvedAt, itemId);
}

function appendLaneHealEvent(
  laneId: string,
  payload: Record<string, unknown>,
): void {
  getDb().prepare(`
    INSERT INTO lane_events (id, lane_id, verb, actor, payload_json, timestamp)
    VALUES (?, ?, 'heal_bot', 'system', ?, ?)
  `).run(
    `evt-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
    laneId,
    JSON.stringify(payload),
    nowIso(),
  );
}

async function resolveLane(item: SupervisorInboxItem, payload: SupervisorInboxPayload) {
  const { getLane, findLaneByPacket } = await import('@/lib/lane/registry');
  if (payload.laneId) {
    const byId = getLane(payload.laneId);
    if (byId) return byId;
  }
  if (item.packet_id) {
    return findLaneByPacket(item.packet_id);
  }
  return null;
}

async function markHumanRequired(
  item: SupervisorInboxItem,
  payload: SupervisorInboxPayload,
  reason: string,
  extras?: Partial<NonNullable<SupervisorInboxPayload['healBot']>>,
): Promise<void> {
  const completedAt = nowIso();
  const nextPayload: SupervisorInboxPayload = {
    ...payload,
    healBot: {
      ...payload.healBot,
      ...extras,
      completedAt,
      outcome: extras?.outcome ?? 'give_up',
      giveUpReason: reason,
    },
  };

  updateInboxItem(item.id, 'human_required', nextPayload, completedAt);

  const lane = await resolveLane(item, payload);
  if (!lane) return;

  appendLaneHealEvent(lane.id, {
    outcome: nextPayload.healBot?.outcome ?? 'give_up',
    reason,
    inboxItemId: item.id,
    packetId: item.packet_id,
  });

  const { setLaneStatus } = await import('@/lib/lane/registry');
  setLaneStatus(lane.id, 'awaiting_input', 'system', 'heal_bot_give_up');
}

async function markSelfHealed(
  item: SupervisorInboxItem,
  payload: SupervisorInboxPayload,
  healBot: NonNullable<SupervisorInboxPayload['healBot']>,
): Promise<void> {
  const completedAt = nowIso();
  const nextPayload: SupervisorInboxPayload = {
    ...payload,
    healBot: {
      ...payload.healBot,
      ...healBot,
      completedAt,
      outcome: 'success',
    },
  };

  updateInboxItem(item.id, 'self_healed', nextPayload, completedAt);

  const lane = await resolveLane(item, payload);
  if (!lane) return;

  appendLaneHealEvent(lane.id, {
    outcome: 'success',
    commitSha: healBot.commitSha,
    commitSubject: healBot.commitSubject,
    inboxItemId: item.id,
    packetId: item.packet_id,
  });

  const { getLane, setLaneStatus } = await import('@/lib/lane/registry');
  setLaneStatus(lane.id, 'reviewing', 'system', 'heal_bot_fixed');
  const refreshedLane = getLane(lane.id);
  if (!refreshedLane) return;

  const { triggerAutoReview } = await import('@/lib/lane/auto-review');
  triggerAutoReview(refreshedLane);
}

async function healInboxItem(item: SupervisorInboxItem): Promise<void> {
  const payload = parsePayload(item.payload);
  const attemptedAt = nowIso();
  payload.healBot = {
    ...payload.healBot,
    attemptedAt,
  };

  const cwd = payload.worktreePath?.trim() || item.repo_path;
  if (!cwd) {
    await markHumanRequired(item, payload, 'no worktree path was available for heal-bot');
    return;
  }

  if (!FIXABLE_KINDS.has(item.kind)) {
    await markHumanRequired(item, payload, `${item.kind} requires manual triage`);
    return;
  }

  const beforeHead = await readHeadSha(cwd);
  const prompt = buildHealPrompt(item, payload);
  const healRun = await runHealBotClaude(cwd, prompt);
  const stdoutSnippet = truncate(healRun.stdout);
  const stderrSnippet = truncate(healRun.stderr);
  const giveUpReason = parseGiveUpReason(healRun.stdout, healRun.stderr);

  if (giveUpReason) {
    await markHumanRequired(item, payload, giveUpReason, {
      outcome: 'give_up',
      stdoutSnippet,
      stderrSnippet,
    });
    return;
  }

  if (!healRun.ok) {
    await markHumanRequired(item, payload, healRun.exitReason ?? 'heal-bot exited unsuccessfully', {
      outcome: 'failed',
      stdoutSnippet,
      stderrSnippet,
    });
    return;
  }

  const afterHead = await readHeadSha(cwd);
  if (!beforeHead || !afterHead || beforeHead === afterHead) {
    await markHumanRequired(item, payload, 'heal-bot exited without creating a new commit', {
      outcome: 'failed',
      stdoutSnippet,
      stderrSnippet,
    });
    return;
  }

  const dirtyStatus = await readGitStatus(cwd);
  if (dirtyStatus) {
    await markHumanRequired(item, payload, 'heal-bot left uncommitted changes in the worktree', {
      outcome: 'failed',
      stdoutSnippet,
      stderrSnippet,
    });
    return;
  }

  const { runCompletionTypecheck } = await import('@/lib/supervisor/completion-verification');
  const typecheck = await runCompletionTypecheck(cwd);
  if (!typecheck.ok) {
    await markHumanRequired(item, payload, 'heal-bot commit did not pass `npx tsc --noEmit`', {
      outcome: 'failed',
      stdoutSnippet,
      stderrSnippet,
      typecheckOutput: truncate(typecheck.output),
    });
    return;
  }

  const headSummary = await readHeadSummary(cwd);
  await markSelfHealed(item, payload, {
    attemptedAt,
    stdoutSnippet,
    stderrSnippet,
    typecheckOutput: truncate(typecheck.output),
    commitSha: headSummary.sha ?? afterHead,
    commitSubject: headSummary.subject ?? undefined,
  });
}

function claimPendingItems(): SupervisorInboxItem[] {
  const db = getDb();
  const pending = db.prepare(`
    SELECT id, repo_path, packet_id, kind, payload, status, heal_attempt_count, created_at, resolved_at
      FROM supervisor_inbox
     WHERE status = 'pending'
       AND COALESCE(heal_attempt_count, 0) < 1
     ORDER BY created_at ASC
  `).all() as SupervisorInboxItem[];

  const claimStatement = db.prepare(`
    UPDATE supervisor_inbox
       SET status = 'healing',
           heal_attempt_count = COALESCE(heal_attempt_count, 0) + 1
     WHERE id = ?
       AND status = 'pending'
       AND COALESCE(heal_attempt_count, 0) < 1
  `);

  const claimed: SupervisorInboxItem[] = [];
  for (const item of pending) {
    const result = claimStatement.run(item.id);
    if (result.changes > 0) {
      claimed.push({ ...item, status: 'healing', heal_attempt_count: item.heal_attempt_count + 1 });
    }
  }
  return claimed;
}

function recoverInterruptedHealingItems(): void {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, repo_path, packet_id, kind, payload, status, heal_attempt_count, created_at, resolved_at
      FROM supervisor_inbox
     WHERE status = 'healing'
  `).all() as SupervisorInboxItem[];

  for (const row of rows) {
    const payload = parsePayload(row.payload);
    const reason = 'heal-bot process restarted while the attempt was in flight';
    updateInboxItem(row.id, 'human_required', {
      ...payload,
      healBot: {
        ...payload.healBot,
        completedAt: nowIso(),
        outcome: 'failed',
        giveUpReason: reason,
      },
    }, nowIso());
  }

  db.prepare(`
    UPDATE supervisor_inbox
       SET status = 'human_required',
           resolved_at = COALESCE(resolved_at, datetime('now'))
     WHERE status = 'pending'
       AND COALESCE(heal_attempt_count, 0) >= 1
  `).run();
}

async function drainHealBotQueue(): Promise<void> {
  if (drainInFlight) return;
  drainInFlight = true;

  try {
    const claimed = claimPendingItems();
    for (const item of claimed) {
      try {
        await healInboxItem(item);
      } catch (error) {
        const payload = parsePayload(item.payload);
        await markHumanRequired(
          item,
          payload,
          error instanceof Error ? error.message : String(error),
          { outcome: 'failed' },
        );
      }
    }
  } finally {
    drainInFlight = false;
  }
}

export function enqueueSupervisorInboxItem(input: EnqueueSupervisorInboxItemInput): string {
  const db = getDb();
  const id = randomUUID();
  db.prepare(`
    INSERT INTO supervisor_inbox (
      id,
      repo_path,
      packet_id,
      kind,
      payload,
      status,
      heal_attempt_count,
      created_at,
      resolved_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', 0, datetime('now'), NULL)
  `).run(
    id,
    input.repoPath,
    input.packetId ?? null,
    input.kind,
    serializePayload(input.payload),
  );
  return id;
}

export function startHealBot(): () => void {
  getDb();
  recoverInterruptedHealingItems();

  if (healBotTimer) {
    return () => {
      if (healBotTimer) {
        clearInterval(healBotTimer);
        healBotTimer = null;
      }
    };
  }

  healBotTimer = setInterval(() => {
    void drainHealBotQueue().catch((error) => {
      console.error('[heal-bot] Drain failed:', error);
    });
  }, HEAL_BOT_TICK_MS);
  if (healBotTimer.unref) healBotTimer.unref();

  console.log(`[heal-bot] Started inbox drain (${HEAL_BOT_TICK_MS}ms interval)`);
  void drainHealBotQueue().catch((error) => {
    console.error('[heal-bot] Initial drain failed:', error);
  });

  return () => {
    if (!healBotTimer) return;
    clearInterval(healBotTimer);
    healBotTimer = null;
    console.log('[heal-bot] Stopped inbox drain');
  };
}
