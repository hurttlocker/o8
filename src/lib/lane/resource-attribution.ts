/**
 * Resource attribution — a per-session Activity Monitor for the o8 fleet.
 *
 * One host `ps` sweep is parsed into a pid → row table and a parent→child map.
 * For every candidate agent SESSION we resolve a root pid and sum CPU% + RSS
 * over that pid's ENTIRE subtree (root + all descendants), so a Codex worker
 * that spawns `git`/`tsc`/`node` children is charged for the whole tree.
 *
 * Sessions are resolved from the SAME live sources the rest of the app already
 * trusts — orchestrator turn records, discovered Codex sessions, and live
 * Claude Code processes — never invented. A session whose pid can't be resolved
 * is still listed with null metrics (the UI renders an em-dash). As a pragmatic
 * fallback the sweep also surfaces the top agent-ish ROOT processes that no
 * session claimed (codex / claude / node workers / tmux / o8's own server), so
 * the panel always shows the real resource hogs even where session→pid mapping
 * is incomplete. Only metrics actually computed from `ps` are ever reported.
 */

import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { listActiveOrchestratorTurns } from '@/lib/lane/orchestrator-crash-survival';
import { listActiveLanesWithSessions } from '@/lib/lane/registry';
import { getCodexDiscoveredFleetAdditions } from '@/lib/codex/sessions';
import { findLiveClaudeProcesses } from '@/lib/runtimes/claude-code';
import { routeAction } from '@/lib/runtimes/registry';
import type { RuntimeId } from '@/lib/runtimes/types';
import type { Lane } from '@/lib/lane/types';

const execFileAsync = promisify(execFile);

export type ResourceRowKind = 'session' | 'process';

export interface ResourceRow {
  key: string;
  kind: ResourceRowKind;
  label: string;
  repo: string | null;
  runtime: string | null;
  /** Runtime session key for the graceful-stop path; null for un-sessioned rows. */
  sessionKey: string | null;
  pid: number | null;
  /** CPU percent of a single core, summed over the pid's subtree, or null when unresolved. */
  cpuPercent: number | null;
  /** Resident set size in bytes, summed over the pid's subtree, or null when unresolved. */
  memBytes: number | null;
}

export interface ResourceUsageResult {
  sessions: ResourceRow[];
  processes: ResourceRow[];
  total: {
    cpuPercent: number;
    memBytes: number;
    ramTotalBytes: number;
  };
}

interface PsRow {
  pid: number;
  ppid: number;
  cpu: number;
  memBytes: number;
  command: string;
}

interface SessionCandidate {
  key: string;
  label: string;
  repo: string | null;
  runtime: string | null;
  sessionKey: string | null;
  pid: number | null;
}

const MAX_PROCESS_ROWS = 24;

function basename(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.replace(/\/+$/, '');
  const base = trimmed.split('/').pop();
  return base && base.length > 0 ? base : null;
}

function roundCpu(value: number): number {
  return Math.round(value * 10) / 10;
}

/** One host sweep. macOS `ps` reports rss in KB and pcpu as %-of-one-core. */
async function sweepProcesses(): Promise<PsRow[]> {
  try {
    const { stdout } = await execFileAsync(
      'ps',
      ['-eo', 'pid=,ppid=,pcpu=,rss=,command='],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    const rows: PsRow[] = [];
    for (const line of stdout.split('\n')) {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      const cpu = Number(match[3]);
      const rssKb = Number(match[4]);
      if (!Number.isFinite(pid)) continue;
      rows.push({
        pid,
        ppid: Number.isFinite(ppid) ? ppid : 0,
        cpu: Number.isFinite(cpu) ? cpu : 0,
        memBytes: (Number.isFinite(rssKb) ? rssKb : 0) * 1024,
        command: match[5] ?? '',
      });
    }
    return rows;
  } catch {
    return [];
  }
}

function buildChildMap(rows: PsRow[]): Map<number, number[]> {
  const childrenByPpid = new Map<number, number[]>();
  for (const row of rows) {
    const existing = childrenByPpid.get(row.ppid);
    if (existing) existing.push(row.pid);
    else childrenByPpid.set(row.ppid, [row.pid]);
  }
  return childrenByPpid;
}

/** Collect a root pid + every descendant pid present in the sweep. */
function subtreePids(
  rootPid: number,
  childrenByPpid: Map<number, number[]>,
  byPid: Map<number, PsRow>,
): number[] {
  const collected: number[] = [];
  const visited = new Set<number>();
  const stack = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    if (byPid.has(pid)) collected.push(pid);
    const children = childrenByPpid.get(pid);
    if (children) {
      for (const child of children) {
        if (!visited.has(child)) stack.push(child);
      }
    }
  }
  return collected;
}

function sumSubtree(pids: number[], byPid: Map<number, PsRow>): { cpu: number; memBytes: number } {
  let cpu = 0;
  let memBytes = 0;
  for (const pid of pids) {
    const row = byPid.get(pid);
    if (!row) continue;
    cpu += row.cpu;
    memBytes += row.memBytes;
  }
  return { cpu: roundCpu(cpu), memBytes };
}

/** Classify an agent-ish ROOT process for the pragmatic fallback list. */
function classifyAgentProcess(command: string): { runtime: string; hint: string } | null {
  const lower = command.toLowerCase();
  if (/\/codex\b/.test(command) || /(^|\s)codex\b/.test(command)) {
    return { runtime: 'codex', hint: 'codex' };
  }
  if (/claude(\s+--|\s+-)/.test(command) && !command.includes('.app/')) {
    return { runtime: 'claude-code', hint: 'claude' };
  }
  if (command.includes('out/server/server.js')) {
    return { runtime: 'o8', hint: 'o8 server' };
  }
  if (command.includes('ws-server')) {
    return { runtime: 'o8', hint: 'o8 ws-server' };
  }
  if (lower.includes('tmux')) {
    return { runtime: 'tmux', hint: 'tmux' };
  }
  if (lower.includes('node') && command.includes('.cortex-worktrees')) {
    return { runtime: 'node', hint: 'node worker' };
  }
  return null;
}

/** Pull a worktree packet slug out of a command line when present. */
function repoHintFromCommand(command: string): string | null {
  const match = command.match(/\.cortex-worktrees\/(packet-[a-z0-9-]+)/i);
  return match?.[1] ?? null;
}

function shortCommand(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? command;
  const base = first.split('/').pop() || first;
  return base.slice(0, 40);
}

/** Live Codex agents carry their pid in the surface id or the source label. */
function parseCodexAgentPid(agent: {
  sessionKey?: string | null;
  runtimeSurface?: { sourceLabel?: string | null } | null;
}): number | null {
  const idMatch = agent.sessionKey?.match(/^codex-live:(\d+)$/);
  if (idMatch?.[1]) return Number(idMatch[1]);
  const label = agent.runtimeSurface?.sourceLabel ?? '';
  const labelMatch = label.match(/live pid (\d+)/i);
  return labelMatch?.[1] ? Number(labelMatch[1]) : null;
}

/**
 * Gather the candidate agent sessions from the app's existing live sources.
 * Each is later joined to the `ps` sweep for real metrics; unresolved pids stay
 * null so the UI can render an em-dash rather than a fabricated number.
 */
async function collectSessionCandidates(): Promise<SessionCandidate[]> {
  const candidates: SessionCandidate[] = [];

  let lanes: Lane[] = [];
  try {
    lanes = listActiveLanesWithSessions();
  } catch {
    lanes = [];
  }
  const laneBySessionKey = new Map<string, Lane>(
    lanes.filter((lane) => lane.sessionKey).map((lane) => [lane.sessionKey!, lane]),
  );
  const findLaneForThread = (threadId: string | null | undefined): Lane | null => {
    if (!threadId) return null;
    const direct = laneBySessionKey.get(threadId);
    if (direct) return direct;
    for (const [key, lane] of laneBySessionKey) {
      if (key === threadId || key.endsWith(threadId) || key.includes(threadId)) return lane;
    }
    return null;
  };

  // Source 1 — managed orchestrator turns (real pid + thread/session id).
  try {
    for (const turn of listActiveOrchestratorTurns()) {
      const lane = findLaneForThread(turn.threadId);
      const repo = lane ? basename(lane.repoPath) : basename(turn.repoPath);
      const label = lane?.label || turn.sessionName || `${turn.backend} orchestrator`;
      candidates.push({
        key: `turn:${turn.id}`,
        label,
        repo,
        runtime: turn.backend,
        sessionKey: lane?.sessionKey ?? null,
        pid: Number.isFinite(turn.pid) ? turn.pid : null,
      });
    }
  } catch {
    // orchestrator turn ledger unavailable — skip this source
  }

  // Source 2 — discovered Codex sessions that resolve a live pid.
  try {
    const codex = await getCodexDiscoveredFleetAdditions({ fresh: false });
    for (const agent of codex.agents) {
      if (agent.status !== 'running') continue;
      const pid = parseCodexAgentPid(agent);
      const lane = laneBySessionKey.get(agent.sessionKey) ?? findLaneForThread(agent.sessionId);
      const repo = lane
        ? basename(lane.repoPath)
        : agent.runtimeSurface?.reviewContext?.repoSlug ?? basename(agent.workspace);
      candidates.push({
        key: `codex:${agent.sessionKey}`,
        label: lane?.label || agent.name,
        repo: repo ?? null,
        runtime: 'codex',
        sessionKey: agent.sessionKey ?? null,
        pid,
      });
    }
  } catch {
    // Codex discovery unavailable — skip this source
  }

  // Source 3 — live Claude Code processes (pid + cwd).
  try {
    for (const proc of await findLiveClaudeProcesses()) {
      if (!Number.isFinite(proc.pid)) continue;
      const repo = basename(proc.cwd);
      candidates.push({
        key: `claude:${proc.pid}`,
        label: repo ? `${repo} • claude` : `claude (pid ${proc.pid})`,
        repo,
        runtime: 'claude-code',
        // findLiveClaudeProcesses yields pid+cwd only — no durable session key,
        // so these fall to the guarded SIGTERM path rather than a graceful stop.
        sessionKey: null,
        pid: proc.pid,
      });
    }
  } catch {
    // Claude discovery unavailable — skip this source
  }

  return candidates;
}

export async function collectResourceUsage(): Promise<ResourceUsageResult> {
  const ramTotalBytes = os.totalmem();
  const rows = await sweepProcesses();
  const byPid = new Map<number, PsRow>(rows.map((row) => [row.pid, row]));
  const childrenByPpid = buildChildMap(rows);

  // Union of every pid inside a displayed subtree — dedupes the header total
  // and lets the fallback skip anything already charged to a session.
  const coveredPids = new Set<number>();

  const candidates = await collectSessionCandidates();
  const sessions: ResourceRow[] = [];
  const seenPids = new Set<number>();

  for (const candidate of candidates) {
    if (candidate.pid != null) {
      if (seenPids.has(candidate.pid)) continue; // same process surfaced by two sources
      seenPids.add(candidate.pid);
    }
    let cpuPercent: number | null = null;
    let memBytes: number | null = null;
    if (candidate.pid != null && byPid.has(candidate.pid)) {
      const pids = subtreePids(candidate.pid, childrenByPpid, byPid);
      const sum = sumSubtree(pids, byPid);
      cpuPercent = sum.cpu;
      memBytes = sum.memBytes;
      for (const pid of pids) coveredPids.add(pid);
    }
    sessions.push({
      key: candidate.key,
      kind: 'session',
      label: candidate.label,
      repo: candidate.repo,
      runtime: candidate.runtime,
      sessionKey: candidate.sessionKey,
      pid: candidate.pid,
      cpuPercent,
      memBytes,
    });
  }

  // Pragmatic fallback — biggest-first so a matching parent claims its whole
  // subtree before a nested child would; disjoint via coveredPids.
  const processes: ResourceRow[] = [];
  const sortedByMem = [...rows].sort((left, right) => right.memBytes - left.memBytes);
  for (const row of sortedByMem) {
    if (processes.length >= MAX_PROCESS_ROWS) break;
    if (coveredPids.has(row.pid)) continue;
    const classification = classifyAgentProcess(row.command);
    if (!classification) continue;
    // Prefer the top of a same-runtime chain: if the parent is itself an
    // uncovered agent process, let it claim the subtree on its own turn.
    const parent = byPid.get(row.ppid);
    if (parent && !coveredPids.has(parent.pid) && classifyAgentProcess(parent.command)) {
      continue;
    }
    const pids = subtreePids(row.pid, childrenByPpid, byPid);
    const sum = sumSubtree(pids, byPid);
    for (const pid of pids) coveredPids.add(pid);
    processes.push({
      key: `proc:${row.pid}`,
      kind: 'process',
      label: classification.hint,
      repo: repoHintFromCommand(row.command) ?? shortCommand(row.command),
      runtime: classification.runtime,
      sessionKey: null,
      pid: row.pid,
      cpuPercent: sum.cpu,
      memBytes: sum.memBytes,
    });
  }

  const nullsLastByMem = (left: ResourceRow, right: ResourceRow) =>
    (right.memBytes ?? -1) - (left.memBytes ?? -1);
  sessions.sort(nullsLastByMem);
  processes.sort(nullsLastByMem);

  let totalCpu = 0;
  let totalMem = 0;
  for (const pid of coveredPids) {
    const row = byPid.get(pid);
    if (!row) continue;
    totalCpu += row.cpu;
    totalMem += row.memBytes;
  }

  return {
    sessions,
    processes,
    total: {
      cpuPercent: roundCpu(totalCpu),
      memBytes: totalMem,
      ramTotalBytes,
    },
  };
}

// ── Terminate a row (Kill action) ──

export interface KillResourceResult {
  ok: boolean;
  method?: 'interrupt' | 'signal';
  error?: string;
}

function runtimeIdForRow(row: ResourceRow): RuntimeId | null {
  if (row.runtime === 'codex') return 'codex';
  if (row.runtime === 'claude-code' || row.runtime === 'claude') return 'claude-code';
  return null;
}

/**
 * HARD guard — never terminate an o8 core process. Refuses:
 *  - `process.pid` (this server) and its entire ANCESTOR chain (Tauri sidecar…)
 *  - the bundled o8 server (`out/server/server.js`) and the ws-server
 *  - the tmux server/client (killing it would nuke every pane)
 */
function isProtectedPid(pid: number, byPid: Map<number, PsRow>): boolean {
  const selfChain = new Set<number>();
  let cursor: number | undefined = process.pid;
  const visited = new Set<number>();
  while (cursor && cursor > 1 && !visited.has(cursor)) {
    visited.add(cursor);
    selfChain.add(cursor);
    cursor = byPid.get(cursor)?.ppid;
  }
  if (selfChain.has(pid)) return true;

  const row = byPid.get(pid);
  if (!row) return false;
  const command = row.command;
  if (command.includes('out/server/server.js')) return true;
  if (command.includes('ws-server')) return true;
  if (/\btmux\b/.test(command)) return true;
  return false;
}

/**
 * Terminate one resource row. Safety-guarded: only acts on a pid present in the
 * CURRENT sessions[]/processes[] snapshot, and hard-refuses o8's own processes.
 * Session rows with a sessionKey prefer the runtime adapter's graceful interrupt;
 * everything else falls back to a guarded SIGTERM. Never throws.
 */
export async function killResourceRow(input: { pid: number; key?: string | null }): Promise<KillResourceResult> {
  const pid = Number(input.pid);
  if (!Number.isInteger(pid) || pid <= 1) {
    return { ok: false, error: 'A valid process id is required.' };
  }

  // 1) The pid MUST be in the current attribution snapshot.
  const usage = await collectResourceUsage();
  const row = [...usage.sessions, ...usage.processes].find(
    (candidate) => candidate.pid === pid && (!input.key || candidate.key === input.key),
  );
  if (!row) {
    return { ok: false, error: 'That process is no longer in the resource list.' };
  }

  // 2) Hard guard against o8's own processes.
  const rows = await sweepProcesses();
  const byPid = new Map<number, PsRow>(rows.map((entry) => [entry.pid, entry]));
  if (isProtectedPid(pid, byPid)) {
    return { ok: false, error: 'Refusing to terminate an o8 core process (server, ws-server, tmux, or this process chain).' };
  }

  // 3) Graceful stop for sessions the runtime adapter can interrupt.
  const runtimeId = runtimeIdForRow(row);
  if (row.kind === 'session' && row.sessionKey && runtimeId) {
    try {
      const result = await routeAction(runtimeId, 'interrupt', row.sessionKey);
      if (result?.ok) return { ok: true, method: 'interrupt' };
    } catch {
      // fall through to the signal path
    }
  }

  // 4) Guarded SIGTERM fallback for un-sessioned agent processes.
  try {
    process.kill(pid, 'SIGTERM');
    return { ok: true, method: 'signal' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to terminate process.' };
  }
}
