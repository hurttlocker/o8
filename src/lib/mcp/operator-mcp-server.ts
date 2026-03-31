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

const API_BASE = process.env.O8_API_BASE || 'http://localhost:3001';

// ── Helpers ──

async function apiFetch(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  return res.json();
}

function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text }], isError };
}

function jsonResult(data: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

// ── Tool Definitions ──

const TOOLS: McpTool[] = [
  {
    name: 'o8_send',
    description:
      'Send a task to o8 for agent execution, or steer an existing session with a follow-up message.',
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
      'Get a composite overview: running agents, pending approvals, and recent activity.',
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
      'Approve a pending agent action. Use o8_status first to see pending approvals.',
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
      'Reject a pending agent action with an optional reason.',
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
      'Read the recent transcript of an agent session.',
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

const TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  o8_send: handleSend,
  o8_status: handleStatus,
  o8_approve: handleApprove,
  o8_reject: handleReject,
  o8_history: handleHistory,
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
    case 'initialize':
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

// ── Main Loop ──

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
