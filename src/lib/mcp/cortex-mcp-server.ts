#!/usr/bin/env node
/**
 * Cortex IDE MCP Server — stdio JSON-RPC 2.0 server that exposes
 * Cortex operations as tools for the orchestrator Claude Code process.
 *
 * Spawned as a child process by orchestrator-session.ts via --mcp-config.
 * Communicates over stdin/stdout with newline-delimited JSON.
 *
 * Environment:
 *   CORTEX_API_BASE  — e.g. http://localhost:3001 (required)
 *   CORTEX_REPO_PATH — workspace repo path (optional, for context)
 *   CORTEX_REPO_SLUG — e.g. owner/repo (optional, for GitHub queries)
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

const API_BASE = process.env.CORTEX_API_BASE || 'http://localhost:3001';
const REPO_PATH = process.env.CORTEX_REPO_PATH || '';
const REPO_SLUG = process.env.CORTEX_REPO_SLUG || '';

// ── Tool Definitions ──

const TOOLS: McpTool[] = [
  {
    name: 'cortex_fleet_status',
    description:
      'List all active AI agent sessions (Claude Code and Codex). ' +
      'Returns agent names, status, workspace, branch, runtime, and last activity.',
    inputSchema: {
      type: 'object',
      properties: {
        fresh: {
          type: 'boolean',
          description: 'Force a fresh fetch instead of using cache. Default false.',
        },
      },
    },
  },
  {
    name: 'cortex_list_issues',
    description:
      'List open GitHub issues for a repository. Returns issue number, title, labels, author, and body.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository slug (e.g. "owner/repo"). Uses the current repo if omitted.',
        },
      },
    },
  },
  {
    name: 'cortex_list_prs',
    description:
      'List open pull requests for a repository. Returns PR number, title, author, branches, and review status.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository slug (e.g. "owner/repo"). Uses the current repo if omitted.',
        },
      },
    },
  },
  {
    name: 'cortex_ci_status',
    description:
      'Get recent CI/CD pipeline runs (GitHub Actions) for a repository. Returns workflow name, status, conclusion, and branch.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository slug (e.g. "owner/repo"). Uses the current repo if omitted.',
        },
      },
    },
  },
  {
    name: 'cortex_read_packets',
    description:
      'Read the current orchestrator mission state — the planned work packets. ' +
      'Returns the mission prompt, summary, and all packets with their status, dependencies, and lane bindings.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'cortex_update_packet',
    description:
      'Update a single work packet by ID. Can change status, queue state, title, summary, or branch target.',
    inputSchema: {
      type: 'object',
      properties: {
        packetId: {
          type: 'string',
          description: 'The packet ID to update.',
        },
        updates: {
          type: 'object',
          description: 'Fields to update on the packet.',
          properties: {
            title: { type: 'string' },
            summary: { type: 'string' },
            status: {
              type: 'string',
              enum: ['draft', 'queued', 'launching', 'idle', 'running', 'awaiting_review', 'blocked', 'released', 'archived'],
            },
            queueState: { type: 'string', enum: ['draft', 'queued', 'held'] },
            branchTarget: { type: 'string' },
            blockedReason: { type: 'string' },
          },
        },
      },
      required: ['packetId', 'updates'],
    },
  },
  {
    name: 'cortex_list_approvals',
    description:
      'List pending approval requests from AI agents. Returns approval ID, title, risk level, tool name, and description.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionKey: {
          type: 'string',
          description: 'Filter approvals by session key. Returns all pending if omitted.',
        },
      },
    },
  },
  {
    name: 'cortex_resolve_approval',
    description:
      'Approve or reject a pending approval request.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The approval ID to resolve.' },
        action: { type: 'string', enum: ['approve', 'reject'], description: 'Whether to approve or reject.' },
      },
      required: ['id', 'action'],
    },
  },
  // ── Delegation tools ──
  {
    name: 'cortex_launch_agent',
    description:
      'Launch a new Codex agent session with a task prompt. The agent runs autonomously in its own workspace tab. ' +
      'Returns a surfaceId you can use with cortex_steer_agent and cortex_read_transcript.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The task for the agent to complete. Be specific and actionable.',
        },
        repoPath: {
          type: 'string',
          description: 'Absolute path to the repo the agent should work in. Defaults to the current repo if omitted.',
        },
        taskName: {
          type: 'string',
          description: 'Short human-readable name for the task (shown in the UI).',
        },
        isolate: {
          type: 'boolean',
          description: 'Create an isolated git worktree branch for this task. Default false (works on current branch).',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'cortex_steer_agent',
    description:
      'Send a follow-up message to a running Codex agent session. Use this to redirect, clarify, or give additional instructions.',
    inputSchema: {
      type: 'object',
      properties: {
        surfaceId: {
          type: 'string',
          description: 'The surfaceId of the agent session (returned by cortex_launch_agent or cortex_fleet_status).',
        },
        message: {
          type: 'string',
          description: 'The follow-up instruction or message to send to the agent.',
        },
      },
      required: ['surfaceId', 'message'],
    },
  },
  {
    name: 'cortex_read_transcript',
    description:
      'Read the recent transcript of a Codex agent session. Shows what the agent has been doing — messages, tool calls, and outputs.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionKey: {
          type: 'string',
          description: 'The surfaceId/sessionKey of the agent session.',
        },
        limit: {
          type: 'number',
          description: 'Number of transcript entries to return. Default 20.',
        },
      },
      required: ['sessionKey'],
    },
  },
  {
    name: 'cortex_interrupt_agent',
    description:
      'Interrupt/stop a running Codex agent session. Use when an agent is going off-track or needs to be halted.',
    inputSchema: {
      type: 'object',
      properties: {
        surfaceId: {
          type: 'string',
          description: 'The surfaceId of the agent session to interrupt.',
        },
      },
      required: ['surfaceId'],
    },
  },
];

// ── Tool Handlers ──

async function apiFetch(path: string, options?: RequestInit): Promise<unknown> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
  });
  return res.json();
}

function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text }], isError };
}

function jsonResult(data: unknown, isError = false): McpToolResult {
  return textResult(JSON.stringify(data, null, 2), isError);
}

async function handleFleetStatus(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const fresh = args.fresh ? '1' : '';
    const data = await apiFetch(`/api/runtime/inventory?fresh=${fresh}`) as Record<string, unknown>;
    const allAgents = (data.agents ?? []) as Array<Record<string, unknown>>;
    // Filter to the supported local coding runtimes only.
    const agents = allAgents.filter((a) => a.runtime === 'claude-code' || a.runtime === 'codex');
    // Return a concise summary
    const summary = agents.map((a) => ({
      name: a.name,
      runtime: a.runtime,
      status: a.status,
      workspace: a.workspace,
      branch: a.branch,
      task: a.currentTask,
      lastActive: a.lastEventAt,
    }));
    return jsonResult({ agentCount: agents.length, agents: summary });
  } catch (err) {
    return textResult(`Failed to fetch fleet status: ${err}`, true);
  }
}

async function handleListIssues(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const repo = (args.repo as string) || REPO_SLUG;
    const qs = repo ? `?repo=${encodeURIComponent(repo)}` : '';
    const data = await apiFetch(`/api/panel/issues${qs}`) as Record<string, unknown>;
    const issues = (data.issues ?? []) as Array<Record<string, unknown>>;
    const summary = issues.map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      author: (i.author as Record<string, unknown>)?.login ?? null,
      labels: ((i.labels ?? []) as Array<Record<string, unknown>>).map((l) => l.name),
      comments: i.comments,
      created: i.createdAt,
    }));
    return jsonResult({ count: issues.length, repo: data.repo, issues: summary });
  } catch (err) {
    return textResult(`Failed to fetch issues: ${err}`, true);
  }
}

async function handleListPrs(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const repo = (args.repo as string) || REPO_SLUG;
    const qs = repo ? `?repo=${encodeURIComponent(repo)}` : '';
    const data = await apiFetch(`/api/panel/prs${qs}`) as Record<string, unknown>;
    const prs = (data.prs ?? []) as Array<Record<string, unknown>>;
    const summary = prs.map((p) => ({
      number: p.number,
      title: p.title,
      author: (p.author as Record<string, unknown>)?.login ?? null,
      head: p.headRefName,
      base: p.baseRefName,
      additions: p.additions,
      deletions: p.deletions,
      reviewDecision: p.reviewDecision,
      created: p.createdAt,
    }));
    return jsonResult({ count: prs.length, repo: data.repo, prs: summary });
  } catch (err) {
    return textResult(`Failed to fetch PRs: ${err}`, true);
  }
}

async function handleCiStatus(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const repo = (args.repo as string) || REPO_SLUG;
    const qs = repo ? `?repo=${encodeURIComponent(repo)}` : '';
    const data = await apiFetch(`/api/panel/ci${qs}`) as Record<string, unknown>;
    const runs = (data.runs ?? []) as Array<Record<string, unknown>>;
    const summary = runs.map((r) => ({
      workflow: r.workflowName,
      title: r.displayTitle,
      branch: r.headBranch,
      status: r.status,
      conclusion: r.conclusion,
      updated: r.updatedAt,
    }));
    return jsonResult({ count: runs.length, repo: data.repo, runs: summary });
  } catch (err) {
    return textResult(`Failed to fetch CI status: ${err}`, true);
  }
}

async function handleReadPackets(): Promise<McpToolResult> {
  try {
    const data = await apiFetch('/api/orchestrator/state') as Record<string, unknown>;
    const mission = data.mission as Record<string, unknown> | undefined;
    if (!mission) return jsonResult({ packets: [], prompt: '', summary: '' });
    const packets = (mission.packets ?? []) as Array<Record<string, unknown>>;
    const summary = packets.map((p) => ({
      id: p.id,
      ref: p.referenceLabel,
      title: p.title,
      status: p.status,
      queueState: p.queueState,
      runtime: p.runtime,
      branch: p.branchTarget,
      dependencies: p.dependencyLabels,
      blocked: p.blockedReason,
      lastEvent: p.lastEventLabel,
    }));
    return jsonResult({
      prompt: mission.prompt,
      summary: mission.summary,
      packetCount: packets.length,
      packets: summary,
      updatedAt: mission.updatedAt,
    });
  } catch (err) {
    return textResult(`Failed to read packets: ${err}`, true);
  }
}

async function handleUpdatePacket(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const packetId = args.packetId as string;
    const updates = (args.updates ?? {}) as Record<string, unknown>;
    if (!packetId) return textResult('packetId is required', true);

    // Read current state
    const current = await apiFetch('/api/orchestrator/state') as Record<string, unknown>;
    const mission = (current.mission ?? {}) as Record<string, unknown>;
    const packets = (mission.packets ?? []) as Array<Record<string, unknown>>;
    const idx = packets.findIndex((p) => p.id === packetId);
    if (idx === -1) return textResult(`Packet ${packetId} not found`, true);

    // Apply updates
    packets[idx] = { ...packets[idx], ...updates };
    const updated = { ...mission, packets };

    // Write back
    const result = await apiFetch('/api/orchestrator/state', {
      method: 'POST',
      body: JSON.stringify({ mission: updated }),
    }) as Record<string, unknown>;

    return jsonResult({ ok: true, packet: packets[idx], updatedAt: (result.mission as Record<string, unknown>)?.updatedAt });
  } catch (err) {
    return textResult(`Failed to update packet: ${err}`, true);
  }
}

async function handleListApprovals(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const sessionKey = args.sessionKey as string | undefined;
    const qs = sessionKey ? `?sessionKey=${encodeURIComponent(sessionKey)}` : '';
    const data = await apiFetch(`/api/panel/approvals${qs}`) as Record<string, unknown>;
    const approvals = (data.approvals ?? []) as Array<Record<string, unknown>>;
    const pending = approvals.filter((a) => a.status === 'pending');
    const summary = pending.map((a) => ({
      id: a.id,
      title: a.title,
      risk: a.risk,
      tool: a.toolName,
      agent: a.agent,
      description: a.description,
      created: a.createdAt,
    }));
    return jsonResult({ pendingCount: pending.length, approvals: summary });
  } catch (err) {
    return textResult(`Failed to fetch approvals: ${err}`, true);
  }
}

async function handleResolveApproval(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const id = args.id as string;
    const action = args.action as string;
    if (!id || !action) return textResult('id and action are required', true);
    if (action !== 'approve' && action !== 'reject') return textResult('action must be "approve" or "reject"', true);

    const result = await apiFetch('/api/panel/approvals', {
      method: 'POST',
      body: JSON.stringify({ id, action }),
    }) as Record<string, unknown>;

    if (result.ok) {
      return jsonResult({ ok: true, resolved: result.resolved, note: result.note });
    }
    return textResult(`Failed: ${result.error ?? 'unknown error'}`, true);
  } catch (err) {
    return textResult(`Failed to resolve approval: ${err}`, true);
  }
}

// ── Delegation Handlers ──

async function handleLaunchAgent(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const prompt = args.prompt as string;
    if (!prompt) return textResult('prompt is required', true);

    const repoPath = (args.repoPath as string) || REPO_PATH;
    if (!repoPath) return textResult('repoPath is required (not available from env either)', true);

    // Route through the orchestrator delegation endpoint — this creates a lane
    // with governance coverage before launching the Codex session.
    const result = await apiFetch('/api/orchestrator/delegate', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        repoPath,
        taskName: args.taskName || undefined,
        isolate: args.isolate !== false, // Default true for delegated work
      }),
    }) as Record<string, unknown>;

    if (result.approvalId) {
      // Policy engine requires approval before this delegation can proceed
      return jsonResult({
        ok: false,
        laneId: result.laneId,
        approvalId: result.approvalId,
        note: result.note ?? 'Approval required before this agent can be launched.',
        status: 'awaiting_approval',
      });
    }

    if (result.ok) {
      // Register with the supervisor for automatic monitoring
      const surfaceId = result.surfaceId as string;
      try {
        const wsPort = process.env.WS_PORT || '3002';
        await fetch(`http://127.0.0.1:${wsPort}/supervisor/watch`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.WS_TOKEN || 'cortex-ide'}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            surfaceId,
            repoPath,
            laneId: result.laneId,
            name: (args.taskName as string) || prompt.slice(0, 60),
            prompt,
          }),
          signal: AbortSignal.timeout(3000),
        });
      } catch {
        // Best-effort — supervisor may not be running
      }

      return jsonResult({
        ok: true,
        laneId: result.laneId,
        surfaceId,
        branch: result.branch,
        worktreePath: result.worktreePath ?? null,
        note: result.note,
      });
    }
    return textResult(`Delegation failed: ${result.error ?? result.note ?? 'unknown error'}`, true);
  } catch (err) {
    return textResult(`Failed to launch agent: ${err}`, true);
  }
}

async function handleSteerAgent(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const surfaceId = args.surfaceId as string;
    const message = args.message as string;
    if (!surfaceId || !message) return textResult('surfaceId and message are required', true);

    const result = await apiFetch('/api/runtime/action', {
      method: 'POST',
      body: JSON.stringify({
        action: 'steer',
        surfaceId,
        message,
      }),
    }) as Record<string, unknown>;

    if (result.ok) {
      return jsonResult({
        ok: true,
        status: result.status,
        note: result.note,
      });
    }
    return textResult(`Steer failed: ${result.error ?? result.note ?? 'unknown error'}`, true);
  } catch (err) {
    return textResult(`Failed to steer agent: ${err}`, true);
  }
}

async function handleReadTranscript(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const sessionKey = args.sessionKey as string;
    if (!sessionKey) return textResult('sessionKey is required', true);

    const limit = (args.limit as number) || 20;
    const qs = `?sessionKey=${encodeURIComponent(sessionKey)}&limit=${limit}`;
    const data = await apiFetch(`/api/runtime/transcript${qs}`) as Record<string, unknown>;
    const transcript = (data.transcript ?? []) as Array<Record<string, unknown>>;

    const entries = transcript.map((e) => ({
      role: e.role,
      text: typeof e.text === 'string' && e.text.length > 500 ? e.text.slice(0, 500) + '...' : e.text,
      tool: e.toolName ?? null,
      file: e.filePath ?? null,
      time: e.timestampLabel,
    }));

    return jsonResult({ entryCount: entries.length, transcript: entries });
  } catch (err) {
    return textResult(`Failed to read transcript: ${err}`, true);
  }
}

async function handleInterruptAgent(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const surfaceId = args.surfaceId as string;
    if (!surfaceId) return textResult('surfaceId is required', true);

    const result = await apiFetch('/api/runtime/action', {
      method: 'POST',
      body: JSON.stringify({
        action: 'interrupt',
        surfaceId,
      }),
    }) as Record<string, unknown>;

    if (result.ok) {
      return jsonResult({ ok: true, note: result.note });
    }
    return textResult(`Interrupt failed: ${result.error ?? result.note ?? 'unknown error'}`, true);
  } catch (err) {
    return textResult(`Failed to interrupt agent: ${err}`, true);
  }
}

const TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<McpToolResult>> = {
  cortex_fleet_status: handleFleetStatus,
  cortex_list_issues: handleListIssues,
  cortex_list_prs: handleListPrs,
  cortex_ci_status: handleCiStatus,
  cortex_read_packets: handleReadPackets,
  cortex_update_packet: handleUpdatePacket,
  cortex_list_approvals: handleListApprovals,
  cortex_resolve_approval: handleResolveApproval,
  cortex_launch_agent: handleLaunchAgent,
  cortex_steer_agent: handleSteerAgent,
  cortex_read_transcript: handleReadTranscript,
  cortex_interrupt_agent: handleInterruptAgent,
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
          serverInfo: { name: 'cortex-ide', version: '1.0.0' },
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
