import {
  createMission,
  createMissionInline,
  dispatchMission,
  getMissionStatus,
  resetPacket,
  submitPacketReview,
} from '@/lib/mcp/operator-mission-tools';
import {
  type McpTool,
  type McpToolResult,
  errorText,
  jsonResult,
  optionalString,
  parseIssueList,
  parseMissionRuntime,
  parseReviewFindings,
  requiredString,
  textResult,
} from './shared';

export const MISSION_TOOLS: McpTool[] = [
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

export async function handleCreateMission(args: Record<string, unknown>): Promise<McpToolResult> {
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
        // Fire-and-forget: dispatch can take 30–60s on its own, and the
        // combined create+dispatch path often exceeds the MCP client's
        // tool-call timeout (~60s), which closes the transport while the
        // backend is still processing. Return the create result immediately
        // so the caller gets a clean response, and run dispatch in the
        // background. Callers can poll get_mission_status for progress.
        void dispatchMission({ missionId: createResult.missionId }).catch((err) => {
          console.error('[mcp-operator] background dispatch failed', errorText(err));
        });
        return jsonResult({
          ...createResult,
          dispatch: { queued: true, note: 'Dispatch running in background. Use get_mission_status to poll.' },
        });
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
      void dispatchMission({ missionId: createResult.missionId }).catch((err) => {
        console.error('[mcp-operator] background dispatch failed', errorText(err));
      });
      return jsonResult({
        ...createResult,
        dispatch: { queued: true, note: 'Dispatch running in background. Use get_mission_status to poll.' },
      });
    }
    return jsonResult(createResult);
  } catch (error) {
    console.error(`${'[mcp-operator]'} create_mission failed: ${errorText(error)}`);
    return textResult(`Failed to create mission: ${errorText(error)}`, true);
  }
}

export async function handleDispatchMission(args: Record<string, unknown>): Promise<McpToolResult> {
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

export async function handleGetMissionStatus(args: Record<string, unknown>): Promise<McpToolResult> {
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

export async function handleSubmitReview(args: Record<string, unknown>): Promise<McpToolResult> {
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

export async function handleResetPacket(args: Record<string, unknown>): Promise<McpToolResult> {
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
