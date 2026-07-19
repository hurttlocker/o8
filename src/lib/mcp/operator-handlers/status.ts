import {
  type McpTool,
  type McpToolResult,
  apiFetch,
  jsonResult,
  requiredString,
  textResult,
} from './shared';

const LANE_EVENTS_MAX_LONG_POLL_MS = 12_000;
const LANE_EVENTS_FETCH_MARGIN_MS = 2_500;
async function steerSession(sessionKey: string, message: string): Promise<Record<string, unknown>> {
  const result = await apiFetch('/api/runtime/action', {
    method: 'POST',
    body: JSON.stringify({ action: 'steer', surfaceId: sessionKey, message }),
  }) as Record<string, unknown>;
  return result;
}

export const STATUS_TOOLS: McpTool[] = [
  {
    name: 'o8_send',
    description:
      'USE THIS WHEN the user wants you to delegate work to a background coding agent in o8 (phrasings like "have an agent fix this", "kick off a task in o8", "send this to my fleet") OR to nudge an existing session ("tell the agent to also..."). Don\'t try to do the coding yourself — o8 spawns Codex/Claude/Gemini in a worktree and handles review + merge. Example: o8_send({message: "Fix the login bug in auth.ts", repoPath: "/path/to/repo"}) launches a new agent. o8_send({message: "Also update the tests", sessionKey: "codex-owned:abc123"}) steers an existing one.',
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
      'USE THIS WHEN the user asks "what\'s running", "any approvals waiting", "show me my agents", or about pending agent work. Returns a composite overview: running agents, pending approvals, recent activity. Call this FIRST before assuming nothing is happening. Example: o8_status() returns all agents. o8_status({sessionKey: "codex-owned:abc123"}) filters to one session.',
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
    name: 'steer_packet',
    description:
      'Use steer_packet when you want to nudge a parked Codex session with new info, such as typecheck failed and here is the output. Codex warm thread state means this is ~1 turn cost versus rerun_with_feedback, which creates a full new worker. Use rerun_with_feedback when the prior session is gone, or when you need a fresh worker to retry from scratch.',
    inputSchema: {
      type: 'object',
      properties: {
        packetId: {
          type: 'string',
          description: 'Packet id for the parked session to steer.',
        },
        message: {
          type: 'string',
          description: 'Follow-up instruction to append to the existing Codex session.',
        },
      },
      required: ['packetId', 'message'],
    },
  },
  {
    name: 'o8_history',
    description:
      'USE THIS WHEN the user asks "what did the agent do", "show me the conversation", or you need to inspect an in-progress agent\'s reasoning before deciding to interrupt or steer it. Reads the recent transcript of an agent session. Returns the last N messages (default 15). Example: o8_history({sessionKey: "codex-owned:abc123", limit: 30})',
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
    name: 'o8_lane_events',
    description:
      'Stream lane lifecycle events. Pass `since` cursor from the previous response to long-poll for new events. Returns events in chronological order. Blocks up to `timeoutMs` (default 5000, max 12000) waiting for new events when the buffer is empty. Example: o8_lane_events() returns the current buffer. o8_lane_events({since: 47, timeoutMs: 8000}) long-polls for events newer than seq 47.',
    inputSchema: {
      type: 'object',
      properties: {
        since: {
          type: 'number',
          description: 'Event sequence cursor from previous response. Omit on first call.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Max ms to wait for new events. Default 5000, max 12000.',
        },
        lanes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional filter to specific lane ids.',
        },
      },
    },
  },
  {
    name: 'o8_packet_transcript',
    description:
      'Read a paginated tail of a packet\'s codex transcript with normalized events (tool_call / tool_result / assistant / error / done). Pass `tail: true` for the last N events, or `cursor: N` to fetch events with seq > N. Example: o8_packet_transcript({packetId: "P1", tail: true, limit: 20}) returns the last 20 events. o8_packet_transcript({packetId: "P1", cursor: 47}) returns events after seq 47.',
    inputSchema: {
      type: 'object',
      properties: {
        packetId: {
          type: 'string',
          description: 'Packet id to read the transcript for.',
        },
        cursor: {
          type: 'number',
          description: 'Return events with seq > cursor. Ignored when tail is true.',
        },
        tail: {
          type: 'boolean',
          description: 'If true, return the last `limit` events instead of paginating by cursor.',
        },
        limit: {
          type: 'number',
          description: 'Max events to return. Default 50, max 200.',
        },
      },
      required: ['packetId'],
    },
  },
  {
    name: 'o8_operator_defaults',
    description:
      'Read or set the global operator-panel defaults that govern dispatches — the programmatic equivalent of Settings → Operator. Call with NO args to read the current defaults. Pass any subset to update; returns the updated defaults. USE THIS to pick the orchestrator brain before a mission (e.g. Sonnet for routine sweeps, Opus for hard problems) or to tune governance for a sprint. Settings are GLOBAL and persist across missions: read first, change what you need, restore prior values after if the change was for one mission only. Example: o8_operator_defaults({orchestratorModel: "claude-sonnet-5", thinkingEffort: "high"}).',
    inputSchema: {
      type: 'object',
      properties: {
        orchestratorModel: {
          type: 'string',
          description: 'Orchestrator model id, e.g. "claude-opus-4-8" or "claude-sonnet-5". Non-empty string.',
        },
        orchestratorBackend: {
          type: 'string',
          enum: ['auto', 'codex', 'claude', 'openclaw', 'hermes', 'collide', 'fable'],
          description: 'Active in-app orchestrator backend. Use "codex" for Codex GPT-5.5, "claude" for Claude Code, or "auto" for legacy toggle resolution.',
        },
        collideAggregator: {
          type: 'string',
          enum: ['auto', 'claude', 'codex'],
          description: 'Collide aggregator override. "auto" follows the active composer backend; "claude" or "codex" force the synthesizer.',
        },
        thinkingEffort: {
          type: 'string',
          enum: ['adaptive', 'low', 'medium', 'high', 'max', 'xhigh'],
          description: 'Orchestrator thinking-effort level.',
        },
        codexWorkerEffort: {
          type: 'string',
          enum: ['adaptive', 'low', 'medium', 'high', 'max', 'xhigh'],
          description: 'Thinking-effort level for Codex packet workers.',
        },
        claudeWorkerEffort: {
          type: 'string',
          enum: ['adaptive', 'low', 'medium', 'high', 'max', 'xhigh'],
          description: 'Thinking-effort level for Claude Code packet workers.',
        },
        overlapGate: {
          type: 'string',
          enum: ['advisory', 'strict'],
          description: 'Overlap gate mode for parallel packets touching the same files.',
        },
        parallelCap: {
          type: 'number',
          description: 'Max packets running in parallel (1-32).',
        },
        defaultDispatchRuntime: {
          type: 'string',
          enum: ['codex', 'claude-code', 'gemini', 'opencode', 'cursor', 'grok', 'pi'],
          description: 'Default worker runtime for dispatches.',
        },
        defaultDispatchModel: {
          type: 'string',
          description: 'Default worker model id. Pass an empty string to restore the selected runtime default.',
        },
        workersUseBrain: {
          type: 'string',
          enum: ['off', 'auto', 'all'],
          description: 'Whether packet workers are taught to consult the Engineering Brain.',
        },
        healBotEnabled: {
          type: 'boolean',
          description: 'Enable the heal bot for stuck packets.',
        },
        supervisorAutoEscalate: {
          type: 'boolean',
          description: 'Auto-escalate stuck packets to the supervisor.',
        },
        promptCachingEnabled: {
          type: 'boolean',
          description: 'Enable prompt caching for orchestrator sessions.',
        },
        requireApproval: {
          type: 'string',
          enum: ['high-risk', 'surface', 'always', 'never'],
          description: 'Human approval posture for lane merges. "surface" keeps easy reviewed merges moving and routes review-worthy work to its dispatcher; "high-risk" preserves the default behavior; "always" gates every merge; "never" enables normal full autonomy.',
        },
      },
    },
  },
];

const OPERATOR_DEFAULTS_KEYS = [
  'orchestratorModel',
  'orchestratorBackend',
  'collideAggregator',
  'thinkingEffort',
  'codexWorkerEffort',
  'claudeWorkerEffort',
  'overlapGate',
  'parallelCap',
  'defaultDispatchRuntime',
  'defaultDispatchModel',
  'workersUseBrain',
  'healBotEnabled',
  'supervisorAutoEscalate',
  'promptCachingEnabled',
  'requireApproval',
] as const;

export async function handleOperatorDefaults(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const supportedKeys = new Set<string>(OPERATOR_DEFAULTS_KEYS);
    const unknownKeys = Object.keys(args)
      .filter((key) => !supportedKeys.has(key))
      .sort();
    if (unknownKeys.length > 0) {
      return {
        ...jsonResult({
          ok: false,
          error: {
            code: 'unknown_operator_default_keys',
            message: `Unsupported o8_operator_defaults key${unknownKeys.length === 1 ? '' : 's'}: ${unknownKeys.join(', ')}`,
            unknownKeys,
            supportedKeys: [...OPERATOR_DEFAULTS_KEYS],
          },
        }),
        isError: true,
      };
    }
    const update: Record<string, unknown> = {};
    for (const key of OPERATOR_DEFAULTS_KEYS) {
      if (args[key] !== undefined) update[key] = args[key];
    }
    const data = Object.keys(update).length === 0
      ? await apiFetch('/api/panel/operator-defaults')
      : await apiFetch('/api/panel/operator-defaults', {
          method: 'POST',
          body: JSON.stringify(update),
        });
    if (data && typeof data === 'object' && 'error' in (data as Record<string, unknown>)) {
      return textResult(`o8_operator_defaults failed: ${(data as Record<string, unknown>).error}`, true);
    }
    return jsonResult(data);
  } catch (err) {
    console.error(`[o8-operator] o8_operator_defaults failed: ${err}`);
    return textResult(`Failed to read/update operator defaults: ${err}`, true);
  }
}

export async function handleSend(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const message = args.message as string;
    if (!message) return textResult('message is required', true);

    const sessionKey = args.sessionKey as string | undefined;
    let result: Record<string, unknown>;

    if (sessionKey) {
      // Steer existing session
      result = await steerSession(sessionKey, message);
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

    if (result.ok === false) {
      // Don't synthesize a "Launched agent…" summary when the backend said no.
      const reason = (result.error as string) || (result.note as string) || 'unknown error';
      return textResult(`Failed to launch agent: ${reason}`, true);
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

export async function handleSteerPacket(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const packetId = requiredString(args, 'packetId');
    const message = requiredString(args, 'message');
    // #2 Stage 4: route through /api/orchestrator/steer-packet so the lane
    // resolution + status flip run in the Next process (the live registry +
    // warm-session pool), not this MCP process's stale registry instance.
    const res = await apiFetch('/api/orchestrator/steer-packet', {
      method: 'POST',
      body: JSON.stringify({ packetId, message, source: 'orchestrator' }),
    }) as { ok?: boolean; result?: Record<string, unknown> };
    return jsonResult({ ok: true, ...(res.result ?? {}) });
  } catch (err) {
    console.error(`[o8-operator] steer_packet failed: ${err}`);
    return textResult(`Failed to steer packet: ${err}`, true);
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

    // #1476 lie 1 — the summary must be derived from the SAME agents array
    // this payload ships. Trusting the API's summary string let the two
    // answers drift ("0 agents running" beside agents[]={failed}); one
    // derivation, one truth.
    const { summarizeOperatorStatus } = await import('@/lib/orchestrator/operator-status-model');
    const summary = summarizeOperatorStatus({
      agents: agents as unknown as Parameters<typeof summarizeOperatorStatus>[0]['agents'],
      approvalCount,
      recentActivity,
    });

    return jsonResult({
      summary,
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

export async function handleLaneEvents(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const sinceRaw = args.since;
    const since = typeof sinceRaw === 'number' && Number.isFinite(sinceRaw) && sinceRaw >= 0
      ? Math.floor(sinceRaw)
      : 0;

    const timeoutRaw = args.timeoutMs;
    const requestedTimeoutMs = typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw) && timeoutRaw >= 0
      ? Math.floor(timeoutRaw)
      : 5_000;
    const timeoutMs = Math.min(requestedTimeoutMs, LANE_EVENTS_MAX_LONG_POLL_MS);

    const laneFilterRaw = args.lanes;
    const laneFilter = Array.isArray(laneFilterRaw)
      ? laneFilterRaw
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter((entry) => entry.length > 0)
      : [];

    const qs = new URLSearchParams();
    qs.set('since', String(since));
    qs.set('timeoutMs', String(timeoutMs));
    if (laneFilter.length > 0) qs.set('lanes', laneFilter.join(','));

    const data = await apiFetch(`/api/orchestrator/lane-events?${qs.toString()}`, {
      timeoutMs: timeoutMs + LANE_EVENTS_FETCH_MARGIN_MS,
    }) as Record<string, unknown>;
    const events = Array.isArray(data.events) ? data.events as Array<Record<string, unknown>> : [];
    const nextSinceRaw = data.nextSince;
    const nextSince = typeof nextSinceRaw === 'number' && Number.isFinite(nextSinceRaw)
      ? nextSinceRaw
      : since;

    const summary = events.length === 0
      ? `No new lane events (nextSince: ${nextSince})`
      : `${events.length} lane events (nextSince: ${nextSince})`;

    return jsonResult({
      summary,
      data: {
        events,
        nextSince,
        timeoutMs,
        ...(requestedTimeoutMs > timeoutMs ? { requestedTimeoutMs } : {}),
      },
    });
  } catch (err) {
    console.error(`[o8-operator] o8_lane_events failed: ${err}`);
    return textResult(`Failed to read lane events: ${err}`, true);
  }
}

// Cap any oversized string field on a transcript event so a single large
// tool_result payload can't flood the caller's context. The route already
// bounds the raw tail (256KB) + window (200 events); this bounds per-event size.
const PER_EVENT_TEXT_CAP = 2000;
function capTranscriptEvent(event: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    out[key] = typeof value === 'string' && value.length > PER_EVENT_TEXT_CAP
      ? `${value.slice(0, PER_EVENT_TEXT_CAP)}…[+${value.length - PER_EVENT_TEXT_CAP} chars truncated]`
      : value;
  }
  return out;
}

export async function handleTranscript(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const packetIdRaw = args.packetId;
    const packetId = typeof packetIdRaw === 'string' ? packetIdRaw.trim() : '';
    if (!packetId) return textResult('packetId is required', true);

    const cursorRaw = args.cursor;
    const cursor = typeof cursorRaw === 'number' && Number.isFinite(cursorRaw) && cursorRaw >= 0
      ? Math.floor(cursorRaw)
      : undefined;

    const tailRaw = args.tail;
    const tail = tailRaw === true || tailRaw === 'true' || tailRaw === 1;

    const limitRaw = args.limit;
    const limit = typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(200, Math.floor(limitRaw))
      : undefined;

    const qs = new URLSearchParams();
    qs.set('packetId', packetId);
    if (tail) qs.set('tail', 'true');
    if (cursor !== undefined) qs.set('cursor', String(cursor));
    if (limit !== undefined) qs.set('limit', String(limit));

    const data = await apiFetch(`/api/orchestrator/packet-transcript?${qs.toString()}`) as Record<string, unknown>;
    const events = (Array.isArray(data.events) ? data.events as Array<Record<string, unknown>> : []).map(capTranscriptEvent);
    const nextCursorRaw = data.nextCursor;
    const nextCursor = typeof nextCursorRaw === 'number' && Number.isFinite(nextCursorRaw)
      ? nextCursorRaw
      : null;
    const note = typeof data.note === 'string' ? data.note : '';

    const summary = events.length === 0
      ? (note ? `No events (${note})` : `No transcript events for ${packetId}`)
      : `${events.length} transcript events (nextCursor: ${nextCursor ?? 'null'})`;

    return jsonResult({
      summary,
      data: {
        packetId,
        sessionKey: data.sessionKey ?? null,
        events,
        nextCursor,
        note: note || null,
      },
    });
  } catch (err) {
    console.error(`[o8-operator] o8_packet_transcript failed: ${err}`);
    return textResult(`Failed to read packet transcript: ${err}`, true);
  }
}
