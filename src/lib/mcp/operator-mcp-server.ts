#!/usr/bin/env node
/**
 * o8 Operator MCP Server — stdio JSON-RPC 2.0 server that lets users
 * control o8 from their Claude Code terminal.
 *
 * Spawned as a child process via --mcp-config.
 * Communicates over stdin/stdout with newline-delimited JSON.
 *
 * Environment:
 *   O8_API_BASE — e.g. http://localhost:3001 (default)
 */

import { createInterface } from 'node:readline';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrchestratorReviewFinding } from '@/lib/approvals/types';
import {
  approveAndMergePacket,
  createMission,
  createMissionInline,
  dispatchMission,
  getMissionStatus,
  resetPacket,
  submitPacketReview,
} from '@/lib/mcp/operator-mission-tools';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';

// ── Pre-flight diagnostics (run once at startup) ──
// Verifies that the binaries the MCP tools depend on are actually
// installed. Missing binaries don't crash the server — users can still
// call tools that don't need them — but the warnings surface in stderr
// so a broken install fails loudly rather than silently.
function checkBinary(name: string): boolean {
  try {
    execSync(`command -v ${name} 2>/dev/null`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function runPreflightDiagnostics(): void {
  const missing: string[] = [];
  // codex is required for dispatch_mission / create_mission to actually spawn an agent.
  if (!checkBinary('codex')) missing.push('codex');
  // gh is required for create_mission when loading real GitHub issues.
  if (!checkBinary('gh')) missing.push('gh');

  if (missing.length > 0) {
    console.error(
      `[o8-operator] Pre-flight warning: missing binaries on PATH: ${missing.join(', ')}. ` +
      `Tools that depend on them will fail with a clear error. ` +
      `Install with: \`npm i -g @openai/codex-cli\` / \`brew install gh\`.`,
    );
  }
}

// ── Types ──

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

// ── Config ──

/**
 * Resolve the backend base URL. Priority:
 *   1. O8_API_BASE env var (explicit override)
 *   2. O8_API_PORT env var (set by Tauri sidecar at spawn time)
 *   3. ~/.cortex-ide/api-port file (written by Tauri sidecar after probing)
 *   4. Legacy default http://localhost:3001 (dev workflow)
 *
 * This MCP server can be launched long after the Tauri shell picks a port,
 * and that port may not be 3001 if something else owned it. Reading the
 * persisted file keeps the MCP tools pointed at the real backend.
 */
function resolveApiBase(): string {
  if (process.env.O8_API_BASE) return process.env.O8_API_BASE;
  if (process.env.O8_API_PORT) {
    return `http://127.0.0.1:${process.env.O8_API_PORT}`;
  }
  try {
    const dataDir = process.env.CORTEX_IDE_DATA_DIR
      || join(process.env.HOME || '', '.cortex-ide');
    const portFile = join(dataDir, 'api-port');
    if (existsSync(portFile)) {
      const raw = readFileSync(portFile, 'utf-8').trim();
      const n = parseInt(raw, 10);
      if (Number.isInteger(n) && n > 0 && n < 65536) {
        return `http://127.0.0.1:${n}`;
      }
    }
  } catch { /* fall through */ }
  return 'http://localhost:3001';
}

const API_BASE = resolveApiBase();
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [500, 1500, 4000];
const FETCH_TIMEOUT_MS = 15_000;

// ── API Health ──

let _apiHealthy = true;
let _lastHealthCheck = 0;
const HEALTH_CHECK_INTERVAL_MS = 10_000;

async function checkApiHealth(): Promise<boolean> {
  const now = Date.now();
  if (now - _lastHealthCheck < HEALTH_CHECK_INTERVAL_MS) return _apiHealthy;
  _lastHealthCheck = now;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${API_BASE}/api/panel/repos`, { signal: controller.signal });
    clearTimeout(timer);
    _apiHealthy = res.ok;
  } catch {
    _apiHealthy = false;
  }
  return _apiHealthy;
}

// ── Helpers ──

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apiFetch(path: string, init?: RequestInit): Promise<unknown> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
      console.error(`[o8-operator] API retry ${attempt}/${MAX_RETRIES} for ${path} in ${delay}ms`);
      await sleep(delay);
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(`${API_BASE}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...init?.headers },
      });
      clearTimeout(timer);
      _apiHealthy = true;
      return res.json();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      _apiHealthy = false;
      if (lastError.name === 'AbortError') {
        lastError = new Error(`Request to ${path} timed out after ${FETCH_TIMEOUT_MS}ms`);
      }
    }
  }

  throw new Error(
    `o8 API unreachable after ${MAX_RETRIES} retries (${path}): ${lastError?.message ?? 'unknown'}. ` +
    `Expected the o8 backend at ${API_BASE}. ` +
    `Open the o8 desktop app (it launches the backend automatically) or run \`npm run desktop:dev\` from the cortex-ide repo.`,
  );
}

function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text }], isError };
}

function jsonResult(data: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function requiredString(args: Record<string, unknown>, key: string) {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string) {
  const value = args[key];
  return typeof value === 'string' ? value.trim() : '';
}

function parseMissionRuntime(value: unknown): OrchestratorRuntime {
  if (value === undefined || value === null || value === '') {
    return 'codex';
  }
  if (value === 'codex' || value === 'claude-code') {
    return value;
  }
  throw new Error('runtime must be "codex" or "claude-code"');
}

function parseIssueList(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('issues must be a non-empty array');
  }

  const issues = value
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim();
      if (typeof entry === 'number' && Number.isFinite(entry)) return String(Math.floor(entry));
      return '';
    })
    .filter(Boolean);

  if (issues.length === 0) {
    throw new Error('issues must contain at least one issue reference');
  }

  return issues;
}

function normalizeFindingSeverity(value: unknown): OrchestratorReviewFinding['severity'] {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'bug' || normalized === 'high' || normalized === 'critical' || normalized === 'error') {
    return 'bug';
  }
  if (
    normalized === 'rule_violation'
    || normalized === 'medium'
    || normalized === 'warning'
    || normalized === 'policy'
  ) {
    return 'rule_violation';
  }
  if (normalized === 'note' || normalized === 'low' || normalized === 'info') {
    return 'note';
  }
  throw new Error(`Unsupported finding severity: ${String(value)}`);
}

function normalizeFindingResolution(value: unknown): OrchestratorReviewFinding['resolution'] {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'fixed' || normalized === 'resolved') {
    return 'fixed';
  }
  if (normalized === 'accepted' || normalized === 'waived' || normalized === 'intentional') {
    return 'accepted';
  }
  if (normalized === 'deferred' || normalized === 'todo' || normalized === 'followup' || normalized === 'follow-up') {
    return 'deferred';
  }
  throw new Error(`Unsupported finding resolution: ${String(value)}`);
}

function parseReviewFindings(value: unknown): OrchestratorReviewFinding[] {
  if (!Array.isArray(value)) {
    throw new Error('findings must be an array');
  }

  return value.map((finding, index) => {
    if (!finding || typeof finding !== 'object') {
      throw new Error(`findings[${index}] must be an object`);
    }

    const candidate = finding as Record<string, unknown>;
    const file = typeof candidate.file === 'string' ? candidate.file.trim() : '';
    const description = typeof candidate.description === 'string' ? candidate.description.trim() : '';
    if (!file || !description) {
      throw new Error(`findings[${index}] must include file and description`);
    }

    const line = candidate.line;
    if (line !== undefined && (typeof line !== 'number' || !Number.isFinite(line) || line < 1)) {
      throw new Error(`findings[${index}].line must be a positive number`);
    }

    return {
      file,
      line: typeof line === 'number' ? Math.floor(line) : undefined,
      severity: normalizeFindingSeverity(candidate.severity),
      description,
      resolution: normalizeFindingResolution(candidate.resolution),
    };
  });
}

// ── Tool Definitions ──

const TOOLS: McpTool[] = [
  {
    name: 'o8_send',
    description:
      'Send a task to o8 for agent execution, or steer an existing session with a follow-up message. Example: o8_send({message: "Fix the login bug in auth.ts", repoPath: "/path/to/repo"}) launches a new agent. o8_send({message: "Also update the tests", sessionKey: "codex-owned:abc123"}) steers an existing one.',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The task prompt or follow-up message to send.',
        },
        sessionKey: {
          type: 'string',
          description: 'If provided, steers an existing session instead of launching a new one.',
        },
        repoPath: {
          type: 'string',
          description: 'Absolute path to the repo for a new task. Ignored when steering.',
        },
        taskName: {
          type: 'string',
          description: 'Short human-readable name for a new task. Ignored when steering.',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'o8_status',
    description:
      'Get a composite overview: running agents, pending approvals, and recent activity. Example: o8_status() returns all agents. o8_status({sessionKey: "codex-owned:abc123"}) filters to one session.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionKey: {
          type: 'string',
          description: 'Filter to a specific session. Returns all if omitted.',
        },
      },
    },
  },
  {
    name: 'o8_approve',
    description:
      'Approve a pending agent action. Call o8_status() first to see pending approvals and get the approval ID. Example: o8_approve({id: "appr-abc123"})',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The approval ID to approve.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'o8_reject',
    description:
      'Reject a pending agent action with an optional reason. Example: o8_reject({id: "appr-abc123", reason: "Needs error handling"})',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The approval ID to reject.',
        },
        reason: {
          type: 'string',
          description: 'Optional reason for the rejection.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'o8_history',
    description:
      'Read the recent transcript of an agent session. Returns the last N messages (default 15). Example: o8_history({sessionKey: "codex-owned:abc123", limit: 30})',
    inputSchema: {
      type: 'object',
      properties: {
        sessionKey: {
          type: 'string',
          description: 'The session key to read the transcript for.',
        },
        limit: {
          type: 'number',
          description: 'Number of transcript entries to return. Default 15.',
        },
      },
      required: ['sessionKey'],
    },
  },
  {
    name: 'create_mission',
    description:
      'Create a sprint mission from GitHub issues or ad-hoc inline tasks, then dispatch agents. By default, all packets run in parallel and dispatch immediately. Use `issues` with GitHub refs (any format: 495, "#495", URL), or `issues_inline` for ad-hoc tasks without GitHub issues. Examples: create_mission({issues: [495, 496], repoPath: "/path/to/repo"}) creates from GitHub issues. create_mission({issues_inline: [{title: "Add dark mode"}, {title: "Fix login button"}], repoPath: "/path/to/repo"}) creates from inline descriptions.',
    inputSchema: {
      type: 'object',
      properties: {
        issues: {
          type: 'array',
          items: { oneOf: [{ type: 'string' }, { type: 'number' }] },
          description: 'GitHub issue references. Accepts any format: 495, "#495", "495", or "https://github.com/org/repo/issues/495". Fetches full issue data via `gh` CLI.',
        },
        issues_inline: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Task summary / issue title.' },
              body: { type: 'string', description: 'Detailed description (optional).' },
            },
            required: ['title'],
          },
          description: 'Ad-hoc inline tasks — no GitHub issue required. Each becomes its own agent packet.',
        },
        repoPath: {
          type: 'string',
          description: 'Absolute local path to the repository.',
        },
        runtime: {
          type: 'string',
          enum: ['codex', 'claude-code'],
          description: 'Runtime to assign to all mission packets. Defaults to codex.',
        },
        constraints: {
          type: 'string',
          description: 'Optional sprint-wide constraints that should be included in packet scope.',
        },
        sequential: {
          type: 'boolean',
          description: 'When true, packets run sequentially (P2 after P1, etc.). Default: false (all packets run in parallel).',
        },
        dispatch: {
          type: 'boolean',
          description: 'When true (default), immediately dispatches all packets after creation. Set false to create without dispatching.',
        },
      },
      required: ['repoPath'],
    },
  },
  {
    name: 'dispatch_mission',
    description:
      'Run the mission dispatch loop. Usually not needed since create_mission auto-dispatches by default. Use this to re-dispatch after resetting failed packets. Example: dispatch_mission() dispatches current mission. dispatch_mission({missionId: "mission-abc123"}) dispatches a specific one.',
    inputSchema: {
      type: 'object',
      properties: {
        missionId: {
          type: 'string',
          description: 'Optional mission ID. If omitted, dispatches the current stored mission.',
        },
      },
    },
  },
  {
    name: 'get_mission_status',
    description:
      'Read sprint-level mission status: waves, packet state, active agents, blockers, and optional cost. Example: get_mission_status() returns current mission. get_mission_status({includeCost: true}) adds cost breakdown.',
    inputSchema: {
      type: 'object',
      properties: {
        missionId: {
          type: 'string',
          description: 'Optional mission ID. If omitted, reads the current stored mission.',
        },
        includeCost: {
          type: 'boolean',
          description: 'Include aggregated runtime cost for the mission.',
        },
      },
    },
  },
  {
    name: 'submit_review',
    description:
      'Record review findings for a completed packet. Findings are relayed to downstream dependent packets. Example: submit_review({packetId: "pkt-abc", approved: true, findings: [{file: "src/foo.ts", severity: "warning", description: "CSS shorthand used", resolution: "Use paddingTop/paddingLeft"}]})',
    inputSchema: {
      type: 'object',
      properties: {
        packetId: {
          type: 'string',
          description: 'The packet ID being reviewed.',
        },
        findings: {
          type: 'array',
          description: 'Review findings to persist.',
          items: {
            type: 'object',
            properties: {
              file: { type: 'string' },
              line: { type: 'number' },
              severity: { type: 'string' },
              description: { type: 'string' },
              resolution: { type: 'string' },
            },
            required: ['file', 'severity', 'description', 'resolution'],
          },
        },
        approved: {
          type: 'boolean',
          description: 'Whether the review approved the packet for merge.',
        },
      },
      required: ['packetId', 'findings', 'approved'],
    },
  },
  {
    name: 'approve_and_merge',
    description:
      'Merge a reviewed packet to main through the lane merge pipeline. Runs the governance policy engine before merging. Example: approve_and_merge({packetId: "pkt-abc"}) or approve_and_merge({packetId: "pkt-abc", commitMessage: "feat: add login flow (#100)"})',
    inputSchema: {
      type: 'object',
      properties: {
        packetId: {
          type: 'string',
          description: 'The packet ID to merge.',
        },
        commitMessage: {
          type: 'string',
          description: 'Optional commit message to use before merging.',
        },
      },
      required: ['packetId'],
    },
  },
  {
    name: 'reset_packet',
    description:
      'Reset a stuck or failed packet back to queued state so it can be re-dispatched. Archives the old lane and session. Call dispatch_mission() after to re-launch. Example: reset_packet({packetId: "pkt-abc", reason: "agent timed out"})',
    inputSchema: {
      type: 'object',
      properties: {
        packetId: {
          type: 'string',
          description: 'The packet ID to reset.',
        },
        reason: {
          type: 'string',
          description: 'Optional reason for the reset (e.g., "worktree lost", "agent failed").',
        },
        clearWorktree: {
          type: 'boolean',
          description: 'Also prune the old worktree directory after resetting.',
        },
      },
      required: ['packetId'],
    },
  },
  {
    name: 'retry_packet',
    description:
      'Alias for reset_packet. Reset a stuck or failed packet back to queued state so it can be re-dispatched. Use when a lane is stuck in session_lost, failed, or recovering. Call dispatch_mission() after to re-launch. Example: retry_packet({packetId: "pkt-abc", reason: "session_lost"})',
    inputSchema: {
      type: 'object',
      properties: {
        packetId: {
          type: 'string',
          description: 'The packet ID to retry.',
        },
        reason: {
          type: 'string',
          description: 'Optional reason for the retry (e.g., "worktree lost", "agent failed").',
        },
        clearWorktree: {
          type: 'boolean',
          description: 'Also prune the old worktree directory after resetting.',
        },
      },
      required: ['packetId'],
    },
  },
];

// ── Tool Handlers ──

async function handleSend(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const message = args.message as string;
    if (!message) return textResult('message is required', true);

    const sessionKey = args.sessionKey as string | undefined;
    let result: Record<string, unknown>;

    if (sessionKey) {
      // Steer existing session
      result = await apiFetch('/api/runtime/action', {
        method: 'POST',
        body: JSON.stringify({ action: 'steer', surfaceId: sessionKey, message }),
      }) as Record<string, unknown>;
    } else {
      // Launch new task via orchestrator
      result = await apiFetch('/api/orchestrator/delegate', {
        method: 'POST',
        body: JSON.stringify({
          prompt: message,
          repoPath: args.repoPath || undefined,
          taskName: args.taskName || undefined,
        }),
      }) as Record<string, unknown>;
    }

    let status: Record<string, unknown> = {};
    try {
      status = await apiFetch('/api/operator/status') as Record<string, unknown>;
    } catch {
      // Best-effort — endpoint may not exist yet
    }

    const laneId = result.laneId as string | undefined;
    const key = sessionKey || (result.surfaceId as string) || (result.sessionKey as string) || 'unknown';
    const currentStatus = (status.status as string) || (result.status as string) || 'launched';
    const repo = (args.repoPath as string) || (result.repoPath as string) || 'default';

    return jsonResult({
      summary: `Launched agent on ${repo}, session ${key}, status: ${currentStatus}`,
      data: {
        ok: result.ok ?? true,
        laneId: laneId ?? null,
        sessionKey: key,
        status: currentStatus,
      },
    });
  } catch (err) {
    console.error(`[o8-operator] o8_send failed: ${err}`);
    return textResult(`Failed to send: ${err}`, true);
  }
}

async function handleStatus(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const sessionKey = args.sessionKey as string | undefined;
    const qs = sessionKey ? `?sessionKey=${encodeURIComponent(sessionKey)}` : '';
    const data = await apiFetch(`/api/operator/status${qs}`) as Record<string, unknown>;

    const agents = (data.agents ?? []) as Array<Record<string, unknown>>;
    const rawApprovals = data.approvals as Record<string, unknown> | Array<Record<string, unknown>> | undefined;
    const approvalItems = Array.isArray(rawApprovals)
      ? rawApprovals
      : Array.isArray((rawApprovals as Record<string, unknown>)?.items)
        ? ((rawApprovals as Record<string, unknown>).items as Array<Record<string, unknown>>)
        : [];
    const approvalCount = typeof (rawApprovals as Record<string, unknown>)?.count === 'number'
      ? (rawApprovals as Record<string, unknown>).count as number
      : approvalItems.length;
    const recentActivity = (data.recentActivity ?? []) as Array<Record<string, unknown>>;

    const runningCount = agents.filter((a) => a.status === 'running' || a.status === 'working').length;
    const lastEvent = recentActivity.length > 0
      ? (recentActivity[0].target as string) || (recentActivity[0].action as string) || 'activity'
      : 'none';

    return jsonResult({
      summary: data.summary || `${runningCount} agents running. ${approvalCount} approvals pending. Last: ${lastEvent}`,
      data: {
        agents,
        approvals: approvalItems,
        approvalCount,
        recentActivity,
      },
    });
  } catch (err) {
    console.error(`[o8-operator] o8_status failed: ${err}`);
    return textResult(`Failed to fetch status: ${err}`, true);
  }
}

async function handleApprove(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const id = args.id as string;
    if (!id) return textResult('id is required', true);

    const result = await apiFetch('/api/panel/approvals', {
      method: 'POST',
      body: JSON.stringify({ id, action: 'approve' }),
    }) as Record<string, unknown>;

    if (result.ok) {
      const resolved = result.resolved as Record<string, unknown> | undefined;
      const title = (resolved?.title as string) || id;
      return jsonResult({
        summary: `Approved: ${title}`,
        data: { ok: true, resolved: result.resolved, note: result.note },
      });
    }
    return textResult(`Approve failed: ${result.error ?? 'unknown error'}`, true);
  } catch (err) {
    console.error(`[o8-operator] o8_approve failed: ${err}`);
    return textResult(`Failed to approve: ${err}`, true);
  }
}

async function handleReject(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const id = args.id as string;
    if (!id) return textResult('id is required', true);

    const result = await apiFetch('/api/panel/approvals', {
      method: 'POST',
      body: JSON.stringify({ id, action: 'reject', reason: args.reason || undefined }),
    }) as Record<string, unknown>;

    if (result.ok) {
      const resolved = result.resolved as Record<string, unknown> | undefined;
      const title = (resolved?.title as string) || id;
      const reason = args.reason ? ` (reason: ${args.reason})` : '';
      return jsonResult({
        summary: `Rejected: ${title}${reason}`,
        data: { ok: true, resolved: result.resolved, note: result.note },
      });
    }
    return textResult(`Reject failed: ${result.error ?? 'unknown error'}`, true);
  } catch (err) {
    console.error(`[o8-operator] o8_reject failed: ${err}`);
    return textResult(`Failed to reject: ${err}`, true);
  }
}

async function handleHistory(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const sessionKey = args.sessionKey as string;
    if (!sessionKey) return textResult('sessionKey is required', true);

    const limit = (args.limit as number) || 15;
    const qs = `?sessionKey=${encodeURIComponent(sessionKey)}&limit=${limit}`;
    const data = await apiFetch(`/api/runtime/transcript${qs}`) as Record<string, unknown>;
    const transcript = (data.transcript ?? []) as Array<Record<string, unknown>>;

    // Truncate entries to 300 chars each
    const entries = transcript.map((e) => ({
      role: e.role,
      text: typeof e.text === 'string' && e.text.length > 300 ? e.text.slice(0, 300) + '...' : e.text,
      tool: e.toolName ?? null,
      time: e.timestampLabel,
    }));

    const lastAction = entries.length > 0
      ? (entries[entries.length - 1].tool as string) || (entries[entries.length - 1].role as string) || 'unknown'
      : 'none';

    return jsonResult({
      summary: `${entries.length} entries. Last action: ${lastAction}`,
      data: { entryCount: entries.length, transcript: entries },
    });
  } catch (err) {
    console.error(`[o8-operator] o8_history failed: ${err}`);
    return textResult(`Failed to read history: ${err}`, true);
  }
}

async function handleCreateMission(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const repoPath = requiredString(args, 'repoPath');
    const runtime = parseMissionRuntime(args.runtime);
    const constraints = optionalString(args, 'constraints');

    // #453 — Support inline issues (no GitHub dependency)
    const inlineIssues = Array.isArray(args.issues_inline) ? args.issues_inline : null;
    const ghIssues = Array.isArray(args.issues) && args.issues.length > 0 ? args.issues : null;

    if (!inlineIssues && !ghIssues) {
      return textResult('Provide either `issues` (GitHub refs) or `issues_inline` (inline objects).', true);
    }

    const shouldDispatch = args.dispatch !== false;
    const sequential = args.sequential === true;

    if (inlineIssues) {
      // #453 — Auto-assign synthetic numbers starting at 90001 when not provided
      const parsed = inlineIssues.map((entry, index) => {
        if (typeof entry !== 'object' || entry === null) throw new Error('Each inline issue must be an object.');
        const e = entry as Record<string, unknown>;
        const title = typeof e.title === 'string' ? e.title.trim() : '';
        if (!title) throw new Error('Each inline issue must have a title.');
        const syntheticNumber = 90001 + index;
        return { number: syntheticNumber, title, body: typeof e.body === 'string' ? e.body : '' };
      });
      const createResult = await createMissionInline({
        issues_inline: parsed,
        repoPath,
        runtime,
        constraints,
        sequential,
      });
      if (shouldDispatch && createResult && !('error' in createResult)) {
        const dispatchResult = await dispatchMission({ missionId: createResult.missionId });
        return jsonResult({ ...createResult, dispatch: dispatchResult });
      }
      return jsonResult(createResult);
    }

    const createResult = await createMission({
      issues: parseIssueList(args.issues),
      repoPath,
      runtime,
      constraints,
      sequential,
    });
    if (shouldDispatch && createResult && !('error' in createResult)) {
      const dispatchResult = await dispatchMission({ missionId: createResult.missionId });
      return jsonResult({ ...createResult, dispatch: dispatchResult });
    }
    return jsonResult(createResult);
  } catch (error) {
    console.error(`${'[mcp-operator]'} create_mission failed: ${errorText(error)}`);
    return textResult(`Failed to create mission: ${errorText(error)}`, true);
  }
}

async function handleDispatchMission(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const result = await dispatchMission({
      missionId: optionalString(args, 'missionId') || undefined,
    });
    return jsonResult(result);
  } catch (error) {
    console.error(`${'[mcp-operator]'} dispatch_mission failed: ${errorText(error)}`);
    return textResult(`Failed to dispatch mission: ${errorText(error)}`, true);
  }
}

async function handleGetMissionStatus(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const includeCost = typeof args.includeCost === 'boolean' ? args.includeCost : false;
    const result = await getMissionStatus({
      missionId: optionalString(args, 'missionId') || undefined,
      includeCost,
    });
    return jsonResult(result);
  } catch (error) {
    console.error(`${'[mcp-operator]'} get_mission_status failed: ${errorText(error)}`);
    return textResult(`Failed to read mission status: ${errorText(error)}`, true);
  }
}

async function handleSubmitReview(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    if (typeof args.approved !== 'boolean') {
      throw new Error('approved is required');
    }

    const result = await submitPacketReview({
      packetId: requiredString(args, 'packetId'),
      findings: parseReviewFindings(args.findings),
      approved: args.approved,
    });
    return jsonResult(result);
  } catch (error) {
    console.error(`${'[mcp-operator]'} submit_review failed: ${errorText(error)}`);
    return textResult(`Failed to submit review: ${errorText(error)}`, true);
  }
}

async function handleApproveAndMerge(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const result = await approveAndMergePacket({
      packetId: requiredString(args, 'packetId'),
      commitMessage: optionalString(args, 'commitMessage') || undefined,
    });
    return jsonResult(result);
  } catch (error) {
    console.error(`${'[mcp-operator]'} approve_and_merge failed: ${errorText(error)}`);
    return textResult(`Failed to approve and merge: ${errorText(error)}`, true);
  }
}

async function handleResetPacket(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const result = await resetPacket({
      packetId: requiredString(args, 'packetId'),
      reason: optionalString(args, 'reason') || undefined,
      clearWorktree: args.clearWorktree === true,
    });
    return jsonResult(result);
  } catch (error) {
    console.error(`${'[mcp-operator]'} reset_packet failed: ${errorText(error)}`);
    return textResult(`Failed to reset packet: ${errorText(error)}`, true);
  }
}

const TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  o8_send: handleSend,
  o8_status: handleStatus,
  o8_approve: handleApprove,
  o8_reject: handleReject,
  o8_history: handleHistory,
  create_mission: handleCreateMission,
  dispatch_mission: handleDispatchMission,
  get_mission_status: handleGetMissionStatus,
  submit_review: handleSubmitReview,
  approve_and_merge: handleApproveAndMerge,
  reset_packet: handleResetPacket,
  retry_packet: handleResetPacket,
};

// ── JSON-RPC Server ──

function send(msg: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handleMessage(msg: JsonRpcRequest): Promise<void> {
  const { method, id, params } = msg;

  // Notifications (no id) — just acknowledge
  if (id === undefined || id === null) return;

  switch (method) {
    case 'initialize': {
      // Fire-and-forget health check so first tool call has warm status
      checkApiHealth().catch(() => {});
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'o8-operator', version: '1.0.0' },
        },
      });
      break;
    }

    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS },
      });
      break;

    case 'tools/call': {
      const toolName = (params as Record<string, unknown>)?.name as string;
      const toolArgs = ((params as Record<string, unknown>)?.arguments ?? {}) as Record<string, unknown>;
      const handler = TOOL_HANDLERS[toolName];
      if (!handler) {
        send({ jsonrpc: '2.0', id, result: textResult(`Unknown tool: ${toolName}`, true) });
        break;
      }
      try {
        const result = await handler(toolArgs);
        send({ jsonrpc: '2.0', id, result });
      } catch (err) {
        send({ jsonrpc: '2.0', id, result: textResult(`Tool error: ${err}`, true) });
      }
      break;
    }

    default:
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
  }
}

// ── Process Resilience ──
// Prevent unhandled rejections from killing the MCP server process.
// The server must survive dev server restarts, transient API failures, etc.
process.on('uncaughtException', (err) => {
  console.error(`[o8-operator] Uncaught exception (survived): ${err.message}`);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[o8-operator] Unhandled rejection (survived): ${reason}`);
});

// ── Main Loop ──

runPreflightDiagnostics();

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line) as JsonRpcRequest;
    handleMessage(msg).catch((err) => {
      if (msg.id !== undefined) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(err) } });
      }
    });
  } catch {
    // Malformed JSON — ignore
  }
});

rl.on('close', () => process.exit(0));
