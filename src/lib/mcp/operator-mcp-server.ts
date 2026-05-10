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
  MISSION_TOOLS,
  handleCreateMission,
  handleDispatchMission,
  handleGetMissionStatus,
  handleRerunWithFeedback,
  handleResetPacket,
  handleReviewState,
  handleSubmitReview,
  handleWaitForMissionReady,
} from '@/lib/mcp/operator-handlers/mission';
import {
  type McpTool,
  type McpToolResult,
  checkApiHealth,
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
    const dataDir = process.env.CORTEX_IDE_DATA_DIR
      || join(process.env.HOME || '', '.o8');
    const portFile = join(dataDir, 'api-port');
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
  let envelope: { ok: boolean; data?: unknown; err?: string };
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
  envelope = parsed as { ok: boolean; data?: unknown; err?: string };
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

// ── Tool Definitions ──

const TOOLS: McpTool[] = [
  ...STATUS_TOOLS.filter((t) => t.name === 'o8_send'),
  ...STATUS_TOOLS.filter((t) => t.name === 'o8_status'),
  ...APPROVE_TOOLS.filter((t) => t.name === 'o8_approve'),
  ...APPROVE_TOOLS.filter((t) => t.name === 'o8_reject'),
  ...STATUS_TOOLS.filter((t) => t.name === 'o8_history'),
  ...STATUS_TOOLS.filter((t) => t.name === 'o8_lane_events'),
  ...STATUS_TOOLS.filter((t) => t.name === 'o8_packet_transcript'),
  ...O8_WEBVIEW_TOOLS,
  ...LOOP_OBSERVABILITY_TOOLS,
  ...MISSION_TOOLS.filter((t) => t.name === 'create_mission'),
  ...MISSION_TOOLS.filter((t) => t.name === 'dispatch_mission'),
  ...MISSION_TOOLS.filter((t) => t.name === 'get_mission_status'),
  ...MISSION_TOOLS.filter((t) => t.name === 'wait_for_mission_ready'),
  ...MISSION_TOOLS.filter((t) => t.name === 'submit_review'),
  ...APPROVE_TOOLS.filter((t) => t.name === 'approve_and_merge'),
  ...APPROVE_TOOLS.filter((t) => t.name === 'o8_merge_preview'),
  ...MISSION_TOOLS.filter((t) => t.name === 'reset_packet'),
  ...MISSION_TOOLS.filter((t) => t.name === 'retry_packet'),
  ...MISSION_TOOLS.filter((t) => t.name === 'o8_review_state'),
];

const TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  o8_send: handleSend,
  o8_status: handleStatus,
  o8_approve: handleApprove,
  o8_reject: handleReject,
  o8_history: handleHistory,
  o8_lane_events: handleLaneEvents,
  o8_packet_transcript: handleTranscript,
  ...createO8WebviewToolHandlers(getO8WebviewClient),
  o8_view_console_errors: handleConsoleErrors,
  o8_view_active_route: handleActiveRoute,
  create_mission: handleCreateMission,
  dispatch_mission: handleDispatchMission,
  get_mission_status: handleGetMissionStatus,
  wait_for_mission_ready: handleWaitForMissionReady,
  submit_review: handleSubmitReview,
  approve_and_merge: handleApproveAndMerge,
  o8_merge_preview: handleMergePreview,
  reset_packet: handleResetPacket,
  retry_packet: handleResetPacket,
  rerun_with_feedback: handleRerunWithFeedback,
  o8_review_state: handleReviewState,
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
