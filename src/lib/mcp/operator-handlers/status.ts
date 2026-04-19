import {
  type McpTool,
  type McpToolResult,
  apiFetch,
  jsonResult,
  textResult,
} from './shared';

export const STATUS_TOOLS: McpTool[] = [
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
];

export async function handleSend(args: Record<string, unknown>): Promise<McpToolResult> {
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

export async function handleStatus(args: Record<string, unknown>): Promise<McpToolResult> {
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

export async function handleHistory(args: Record<string, unknown>): Promise<McpToolResult> {
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
