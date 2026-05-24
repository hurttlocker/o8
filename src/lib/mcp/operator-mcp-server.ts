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

// MUST be first: neutralizes the `server-only` marker so this standalone Node
// process (launched via `tsx` on the TS source in dev) doesn't crash when a
// shared library module transitively imports `server-only`. See the module's
// header for the full rationale.
import './neutralize-server-only';

import { createInterface } from 'node:readline';
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';
import { O8_WEBVIEW_TOOLS, createO8WebviewToolHandlers } from '@/lib/mcp/o8-webview-tools';
import {
  APPROVE_TOOLS,
  handleApprove,
  handleApproveAndMerge,
  handleMergePreview,
  handleReject,
} from '@/lib/mcp/operator-handlers/approve';
import {
  CORTEX_TOOLS,
  handleAsk,
  handleProposeObservation,
} from '@/lib/mcp/operator-handlers/cortex';
import {
  SPEC_TOOLS,
  handleSpecRead,
  handleSpecReviewIndex,
  handleSpecPendingFeedback,
  handleSpecValidate,
  handleSpecComment,
  handleSpecReply,
  handleSpecResolve,
  handleSpecSuggest,
} from '@/lib/mcp/operator-handlers/spec';
import {
  MISSION_TOOLS,
  handleCreateMission,
  handleDispatchMission,
  handleGetMissionStatus,
  handleGetPacketScope,
  handlePacketDiff,
  handleMissionTail,
  handleReportPacketEvent,
  handleRerunWithFeedback,
  handleResetPacket,
  handleRetryPacket,
  handleReviewState,
  handleSubmitReview,
  handleTaskArchive,
  handleTaskBlock,
  handleTaskBrief,
  handleTaskClaim,
  handleTaskCreate,
  handleTaskDispatch,
  handleTaskList,
  handleTaskPrune,
  handleTaskReport,
  handleWaitForMissionReady,
} from '@/lib/mcp/operator-handlers/mission';
import {
  REPO_MGMT_TOOLS,
  handleCreateProject,
  handleInitRepo,
  handleRegisterRepo,
  handleScaffold,
} from '@/lib/mcp/operator-handlers/repo-management';
import {
  type McpTool,
  type McpToolResult,
  checkApiHealth,
  jsonResult,
  setApiBase,
  textResult,
} from '@/lib/mcp/operator-handlers/shared';
import {
  STATUS_TOOLS,
  handleHistory,
  handleLaneEvents,
  handleSend,
  handleStatus,
  handleTranscript,
} from '@/lib/mcp/operator-handlers/status';

const ORPHAN_MIN_AGE_SECONDS = 30;
const OPERATOR_COMMAND_RE = /^(?:\S+\/)?(?:npm|npx|node|tsx)\b.*(?:^|\s)\S*operator-mcp-server\.ts(?:\s|$)/;
type ProcessRow = { pid: number; ppid: number; ageSeconds: number; args: string };

function parseElapsedSeconds(raw: string): number {
  const [dayText, timeText] = raw.includes('-') ? raw.split('-', 2) : ['0', raw];
  const days = Number(dayText);
  const segments = timeText.split(':').map(Number);
  if (!Number.isFinite(days) || segments.length > 3 || segments.some((part) => !Number.isFinite(part))) {
    return -1;
  }
  while (segments.length < 3) segments.unshift(0);
  const [hours = 0, minutes = 0, seconds = 0] = segments;
  return (days * 24 * 60 * 60) + (hours * 60 * 60) + (minutes * 60) + seconds;
}

function listProcessRows(): ProcessRow[] {
  const output = execFileSync('ps', ['-e', '-o', 'pid=,ppid=,etime=,command='], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 3000,
  });
  const rows: ProcessRow[] = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!match) continue;
    rows.push({
      pid: parseInt(match[1], 10),
      ppid: parseInt(match[2], 10),
      ageSeconds: parseElapsedSeconds(match[3]),
      args: match[4] || '',
    });
  }
  return rows;
}

function isOperatorMcpCommand(args: string): boolean { return OPERATOR_COMMAND_RE.test(args.trim()); }

function isAncestorPid(pid: number, selfPid: number, rowsByPid: Map<number, ProcessRow>): boolean {
  let currentPid = rowsByPid.get(selfPid)?.ppid ?? process.ppid;
  const seen = new Set<number>();
  while (currentPid > 1 && !seen.has(currentPid)) {
    if (currentPid === pid) return true;
    seen.add(currentPid);
    currentPid = rowsByPid.get(currentPid)?.ppid ?? 0;
  }
  return false;
}

function isDetachedOperatorTree(row: ProcessRow, rowsByPid: Map<number, ProcessRow>): boolean {
  let parentPid = row.ppid;
  const seen = new Set<number>();
  while (parentPid > 1 && !seen.has(parentPid)) {
    seen.add(parentPid);
    const parent = rowsByPid.get(parentPid);
    if (!parent || !isOperatorMcpCommand(parent.args)) return false;
    parentPid = parent.ppid;
  }
  return parentPid === 1;
}

function nodeLabelFromArgs(args: string): string {
  const cellar = args.match(/\/node(?:@[\d.]+)?\/(\d+\.\d+\.\d+(?:_\d+)?)\/bin\/node/)?.[1];
  const nodeAt = args.match(/node@(\d+(?:\.\d+)*)/)?.[1];
  return cellar?.replace(/_/g, '.') ?? (nodeAt ? `node@${nodeAt}` : 'unknown');
}

function killOrphanInstances(): void {
  if (process.env.O8_MCP_NO_ORPHAN_KILL === '1') return;
  try {
    const myPid = process.pid;
    const myParentPid = process.ppid;
    const rows = listProcessRows();
    const rowsByPid = new Map(rows.map((row) => [row.pid, row]));
    const myParentParentPid = rowsByPid.get(myParentPid)?.ppid ?? 0;

    for (const row of rows) {
      if (row.pid === myPid) continue;
      if (!isOperatorMcpCommand(row.args)) continue;
      if (row.ageSeconds < ORPHAN_MIN_AGE_SECONDS) continue;
      if (isAncestorPid(row.pid, myPid, rowsByPid)) continue;
      if (row.ppid === myParentPid) continue;
      if (myParentParentPid > 1 && row.ppid === myParentParentPid) continue;
      if (!isDetachedOperatorTree(row, rowsByPid)) continue;

      try {
        process.kill(row.pid, 'SIGTERM');
        console.error(`[mcp-operator] killed orphan PID ${row.pid} (parent=${row.ppid}, node=${nodeLabelFromArgs(row.args)})`);
        const killTimer = setTimeout(() => {
          try {
            process.kill(row.pid, 0);
            process.kill(row.pid, 'SIGKILL');
          } catch { /* already gone */ }
        }, 2000) as ReturnType<typeof setTimeout> & { unref?: () => void };
        killTimer.unref?.();
      } catch { /* ignore per-process kill failures */ }
    }
  } catch (err) {
    console.error(`[mcp-operator] orphan cleanup failed: ${err}`);
  }
}

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

// ── Config ──

function getDataDir(): string {
  return process.env.CORTEX_IDE_DATA_DIR || join(homedir(), '.o8');
}

function expandHomePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
  return value;
}

function isPathArg(key: string): boolean {
  return key === 'path'
    || key === 'repoPath'
    || key === 'repoPaths'
    || key === 'cwd'
    || key === 'dataDir'
    || key.endsWith('Path')
    || key.endsWith('Paths')
    || key.endsWith('Dir');
}

function expandToolPathArgs(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    return isPathArg(key) ? expandHomePath(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => expandToolPathArgs(entry, key));
  }
  if (value && typeof value === 'object') {
    const expanded: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      expanded[entryKey] = expandToolPathArgs(entryValue, entryKey);
    }
    return expanded;
  }
  return value;
}

function extractRepoEntries(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (
    parsed
    && typeof parsed === 'object'
    && Array.isArray((parsed as { repos?: unknown }).repos)
  ) {
    return (parsed as { repos: unknown[] }).repos;
  }
  return [];
}

function readKnownRepos(): string[] {
  const registryPath = join(getDataDir(), 'repos.json');
  if (!existsSync(registryPath)) return [];

  try {
    const parsed = JSON.parse(readFileSync(registryPath, 'utf-8')) as unknown;
    return extractRepoEntries(parsed)
      .map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return '';
        const record = entry as Record<string, unknown>;
        const rawPath = typeof record.path === 'string'
          ? record.path
          : typeof record.localPath === 'string'
            ? record.localPath
            : '';
        return rawPath.trim() ? resolve(expandHomePath(rawPath)) : '';
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Resolve the backend base URL. Priority:
 *   1. ~/.o8/api-port file (always reflects the running app — survives port
 *      swaps, dev-frontend mode flips, and stale parent-shell env vars)
 *   2. O8_API_BASE env var (explicit override)
 *   3. O8_API_PORT env var (set by Tauri sidecar at spawn time)
 *   4. Legacy default http://localhost:3001 (dev workflow)
 *
 * File-first is critical: Claude Code spawns this MCP from a parent shell
 * whose env may have been set before a port change (e.g. operator started
 * Claude Code while prod was on 3001, then the Tauri shell swapped to a
 * dev-frontend URL on 3010 — the parent O8_API_BASE is now stale). The
 * file is updated by the Tauri sidecar on every boot, so it's the only
 * signal that always agrees with the live backend.
 */
function resolveApiBase(): string {
  try {
    const portFile = join(getDataDir(), 'api-port');
    if (existsSync(portFile)) {
      const raw = readFileSync(portFile, 'utf-8').trim();
      const n = parseInt(raw, 10);
      if (Number.isInteger(n) && n > 0 && n < 65536) {
        return `http://127.0.0.1:${n}`;
      }
    }
  } catch { /* fall through */ }
  if (process.env.O8_API_BASE) return process.env.O8_API_BASE;
  if (process.env.O8_API_PORT) {
    return `http://127.0.0.1:${process.env.O8_API_PORT}`;
  }
  return 'http://localhost:3001';
}

const API_BASE = resolveApiBase();
setApiBase(API_BASE);

let o8WebviewClient: O8WebviewClient | null = null;

function getO8WebviewClient(): O8WebviewClient {
  if (!o8WebviewClient) {
    o8WebviewClient = new O8WebviewClient();
  }
  return o8WebviewClient;
}

// ── Loop observability tools (issues #793, #794) ──
// Both tools read state owned by the Rust ring buffer (`o8_view_console_errors`)
// or the Rust webview handle (`o8_view_active_route`). The data lives outside
// the JS thread, so it survives `o8_view_eval` storms. The transport still
// hops through the plugin's execute_js socket — but the JS shim here is a
// single-line `__TAURI_INTERNALS__.invoke(...)` that completes as soon as
// the listener fires; it doesn't depend on any in-flight UI work.
const LOOP_OBSERVABILITY_TOOLS: McpTool[] = [
  {
    name: 'o8_view_console_errors',
    description: 'Returns runtime errors captured by o8\'s Rust-side ring buffer (window.onerror, unhandledrejection, console.error). Survives a busy JS thread because the buffer is populated as errors fire, not on read. Returns { errors, count, sinceLastFetch }; sinceLastFetch resets on each call.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'o8_view_active_route',
    description: 'Returns the main webview\'s current URL parts ({ pathname, search, hash, routerState }) by querying webview.url() on the Rust side. Use after o8_view_navigate to confirm the route landed without taking a screenshot. routerState is null for now; defer until we wire a Next.js segment reader.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

const USER_CONTEXT_TOOLS: McpTool[] = [
  {
    name: 'o8_user_context',
    description: 'Return local o8 user context for resolving shorthand paths without asking the user. Includes username, homedir, cwd, dataDir, and knownRepos.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

async function invokeTauriCommandFromWebview<T>(command: string): Promise<T> {
  // Small JS shim that hands the read off to a Rust Tauri command and wraps
  // the response in a sentinel envelope. The shim does not depend on any
  // long-running UI work — as soon as the execute_js listener fires, the
  // Rust command resolves and we get the JSON payload back through the
  // plugin's eval bridge.
  const code = `(() => { try {
    if (!window.__TAURI_INTERNALS__ || typeof window.__TAURI_INTERNALS__.invoke !== 'function') {
      return JSON.stringify({ ok: false, err: 'tauri internals unavailable' });
    }
    return window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)})
      .then((r) => JSON.stringify({ ok: true, data: r }))
      .catch((e) => JSON.stringify({ ok: false, err: String(e && e.message || e) }));
  } catch (e) { return JSON.stringify({ ok: false, err: String(e && e.message || e) }); } })()`;

  const { result } = await getO8WebviewClient().evalJs(code);
  // The webview eval bridge wraps Promises by awaiting them, so we get the
  // resolved JSON string here. Parse twice — once for the sentinel, once
  // for the inner data if it came back as a stringified JSON value.
  let parsed: unknown = result;
  try {
    parsed = JSON.parse(result);
  } catch {
    throw new Error(`tauri invoke '${command}' returned non-JSON: ${String(result).slice(0, 200)}`);
  }
  if (typeof parsed === 'string') {
    // Some bridge implementations double-encode — peel one more layer.
    try { parsed = JSON.parse(parsed); } catch { /* leave as is */ }
  }
  const envelope = parsed as { ok: boolean; data?: unknown; err?: string };
  if (!envelope || envelope.ok !== true) {
    throw new Error(envelope?.err || `tauri invoke '${command}' failed`);
  }
  return envelope.data as T;
}

async function handleConsoleErrors(): Promise<McpToolResult> {
  try {
    const data = await invokeTauriCommandFromWebview<{
      errors: Array<{ message: string; source: string; lineno: number; timestamp: number }>;
      count: number;
      sinceLastFetch: number;
    }>('o8_view_console_errors');
    return textResult(JSON.stringify(data));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return textResult(JSON.stringify({ ok: false, error: message }), true);
  }
}

async function handleActiveRoute(): Promise<McpToolResult> {
  try {
    const data = await invokeTauriCommandFromWebview<{
      pathname: string;
      search: string;
      hash: string;
      routerState: string | null;
    }>('o8_view_active_route');
    return textResult(JSON.stringify(data));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return textResult(JSON.stringify({ ok: false, error: message }), true);
  }
}

async function handleUserContext(): Promise<McpToolResult> {
  let username = process.env.USER || '';
  try {
    username = userInfo().username || username;
  } catch { /* keep env fallback */ }

  return jsonResult({
    username,
    homedir: homedir(),
    cwd: process.cwd(),
    dataDir: getDataDir(),
    knownRepos: readKnownRepos(),
  });
}

// ── Tool Definitions ──

const TOOLS: McpTool[] = [
  ...STATUS_TOOLS.filter((t) => t.name === 'o8_send'),
  ...STATUS_TOOLS.filter((t) => t.name === 'o8_status'),
  ...USER_CONTEXT_TOOLS,
  ...REPO_MGMT_TOOLS,
  ...APPROVE_TOOLS.filter((t) => t.name === 'o8_approve'),
  ...APPROVE_TOOLS.filter((t) => t.name === 'o8_reject'),
  ...STATUS_TOOLS.filter((t) => t.name === 'o8_history'),
  ...STATUS_TOOLS.filter((t) => t.name === 'o8_lane_events'),
  ...STATUS_TOOLS.filter((t) => t.name === 'o8_packet_transcript'),
  ...CORTEX_TOOLS,
  ...SPEC_TOOLS,
  ...O8_WEBVIEW_TOOLS,
  ...LOOP_OBSERVABILITY_TOOLS,
  ...MISSION_TOOLS.filter((t) => t.name === 'create_mission'),
  ...MISSION_TOOLS.filter((t) => t.name === 'dispatch_mission'),
  ...MISSION_TOOLS.filter((t) => t.name === 'get_mission_status'),
  ...MISSION_TOOLS.filter((t) => t.name === 'mission_tail'),
  ...MISSION_TOOLS.filter((t) => t.name === 'get_packet_scope'),
  ...MISSION_TOOLS.filter((t) => t.name === 'o8_packet_diff'),
  ...MISSION_TOOLS.filter((t) => t.name === 'o8_task_list'),
  ...MISSION_TOOLS.filter((t) => t.name === 'o8_task_create'),
  ...MISSION_TOOLS.filter((t) => t.name === 'o8_task_brief'),
  ...MISSION_TOOLS.filter((t) => t.name === 'o8_task_claim'),
  ...MISSION_TOOLS.filter((t) => t.name === 'o8_task_dispatch'),
  ...MISSION_TOOLS.filter((t) => t.name === 'o8_task_block'),
  ...MISSION_TOOLS.filter((t) => t.name === 'o8_task_report'),
  ...MISSION_TOOLS.filter((t) => t.name === 'o8_task_archive'),
  ...MISSION_TOOLS.filter((t) => t.name === 'o8_task_prune'),
  ...MISSION_TOOLS.filter((t) => t.name === 'wait_for_mission_ready'),
  ...MISSION_TOOLS.filter((t) => t.name === 'submit_review'),
  ...APPROVE_TOOLS.filter((t) => t.name === 'approve_and_merge'),
  ...APPROVE_TOOLS.filter((t) => t.name === 'o8_merge_preview'),
  ...MISSION_TOOLS.filter((t) => t.name === 'reset_packet'),
  ...MISSION_TOOLS.filter((t) => t.name === 'retry_packet'),
  ...MISSION_TOOLS.filter((t) => t.name === 'rerun_with_feedback'),
  ...MISSION_TOOLS.filter((t) => t.name === 'o8_review_state'),
  ...MISSION_TOOLS.filter((t) => t.name === 'report_packet_event'),
];

const TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  o8_send: handleSend,
  o8_status: handleStatus,
  o8_approve: handleApprove,
  o8_reject: handleReject,
  o8_history: handleHistory,
  o8_lane_events: handleLaneEvents,
  o8_packet_transcript: handleTranscript,
  cortex_propose_observation: handleProposeObservation,
  cortex_ask: handleAsk,
  o8_spec_read: handleSpecRead,
  o8_spec_review_index: handleSpecReviewIndex,
  o8_spec_pending_feedback: handleSpecPendingFeedback,
  o8_spec_validate: handleSpecValidate,
  o8_spec_comment: handleSpecComment,
  o8_spec_reply: handleSpecReply,
  o8_spec_resolve: handleSpecResolve,
  o8_spec_suggest: handleSpecSuggest,
  o8_register_repo: handleRegisterRepo,
  o8_init_repo: handleInitRepo,
  o8_create_project: handleCreateProject,
  o8_scaffold: handleScaffold,
  ...createO8WebviewToolHandlers(getO8WebviewClient),
  o8_view_console_errors: handleConsoleErrors,
  o8_view_active_route: handleActiveRoute,
  o8_user_context: handleUserContext,
  create_mission: handleCreateMission,
  dispatch_mission: handleDispatchMission,
  get_mission_status: handleGetMissionStatus,
  mission_tail: handleMissionTail,
  get_packet_scope: handleGetPacketScope,
  o8_packet_diff: handlePacketDiff,
  o8_task_list: handleTaskList,
  o8_task_create: handleTaskCreate,
  o8_task_brief: handleTaskBrief,
  o8_task_claim: handleTaskClaim,
  o8_task_dispatch: handleTaskDispatch,
  o8_task_block: handleTaskBlock,
  o8_task_report: handleTaskReport,
  o8_task_archive: handleTaskArchive,
  o8_task_prune: handleTaskPrune,
  wait_for_mission_ready: handleWaitForMissionReady,
  submit_review: handleSubmitReview,
  approve_and_merge: handleApproveAndMerge,
  o8_merge_preview: handleMergePreview,
  reset_packet: handleResetPacket,
  retry_packet: handleRetryPacket,
  rerun_with_feedback: handleRerunWithFeedback,
  o8_review_state: handleReviewState,
  report_packet_event: handleReportPacketEvent,
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
      const toolArgs = expandToolPathArgs(
        ((params as Record<string, unknown>)?.arguments ?? {}) as Record<string, unknown>,
      ) as Record<string, unknown>;
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

killOrphanInstances();
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
