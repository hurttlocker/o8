import {
  type McpTool,
  type McpToolResult,
  apiFetch,
  errorText,
  jsonResult,
  optionalString,
  requiredString,
  textResult,
} from './shared';

export const APPROVE_TOOLS: McpTool[] = [
  {
    name: 'o8_approve',
    description:
      'USE THIS WHEN o8_status shows pending approvals and the user says "approve it", "go ahead", "looks good — merge", or you\'ve previewed a merge that\'s blocked by a file-size approval gate. Call o8_status() first to see pending approvals and get the approval ID. Example: o8_approve({id: "appr-abc123"})',
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
      'USE THIS WHEN the user wants to reject a pending agent action ("no", "deny", "that\'s wrong"). Reject with an optional reason so the agent gets useful feedback. Example: o8_reject({id: "appr-abc123", reason: "Needs error handling"})',
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
    name: 'approve_and_merge',
    description:
      'USE THIS WHEN a packet is awaiting_review (per get_mission_status) and you\'ve already reviewed the code via o8_packet_diff and the gates via o8_merge_preview. This is the final step of the dispatch loop — runs the governance policy engine + merges to main. On failure returns {merged:false, checks[], blockers[]} so you know which gate rejected it (file-size? security pattern?). Pass an optional idempotencyKey to safely retry. Example: approve_and_merge({packetId: "pkt-abc"}) or approve_and_merge({packetId: "pkt-abc", commitMessage: "feat: add login flow (#100)", idempotencyKey: "merge-pkt-abc-2026-04-18"})',
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
        idempotencyKey: {
          type: 'string',
          description: 'Optional client-supplied key. Repeat calls with the same key inside a 5-minute window return the cached result without re-running the merge.',
        },
        expectedHeadSha: {
          type: 'string',
          description: 'Optional worktree HEAD SHA expected at merge time. If omitted, o8 uses the reviewed HEAD from submit_review when present.',
        },
      },
      required: ['packetId'],
    },
  },
  {
    name: 'o8_merge_preview',
    description:
      'USE THIS BEFORE approve_and_merge — dry-runs the merge gate so you know which governance check (security patterns, diff budget, untracked imports, self-review integrity) might block and can address it cleanly. Returns {packetId, wouldMerge, checks[], blockers[], branch}. Example: o8_merge_preview({packetId: "pkt-abc"}).',
    inputSchema: {
      type: 'object',
      properties: {
        packetId: {
          type: 'string',
          description: 'The packet ID to preview.',
        },
      },
      required: ['packetId'],
    },
  },
];

export async function handleApprove(args: Record<string, unknown>): Promise<McpToolResult> {
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

export async function handleReject(args: Record<string, unknown>): Promise<McpToolResult> {
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

export async function handleApproveAndMerge(args: Record<string, unknown>): Promise<McpToolResult> {
  const packetId = requiredString(args, 'packetId');
  try {
    // #2 Stage 5: route through /api/orchestrator/merge — idempotency + the
    // synchronous worktree-cleanup now live server-side in that route, so every
    // client inherits them instead of this MCP process owning a private copy.
    const res = await apiFetch('/api/orchestrator/merge', {
      method: 'POST',
      body: JSON.stringify({
        packetId,
        commitMessage: optionalString(args, 'commitMessage') || undefined,
        expectedHeadSha: optionalString(args, 'expectedHeadSha') || undefined,
        idempotencyKey: optionalString(args, 'idempotencyKey') || undefined,
      }),
    }) as { ok?: boolean; result?: Record<string, unknown> };
    return jsonResult(res.result ?? res);
  } catch (error) {
    console.error(`${'[mcp-operator]'} approve_and_merge failed: ${errorText(error)}`);
    return textResult(`Failed to approve and merge: ${errorText(error)}`, true);
  }
}

export async function handleMergePreview(args: Record<string, unknown>): Promise<McpToolResult> {
  const packetId = requiredString(args, 'packetId');
  try {
    // #2 Stage 5: route through /api/orchestrator/merge-preview (in-process
    // previewPacketMerge retired here) so CLI + MCP share one gate-preview path.
    const preview = await apiFetch(`/api/orchestrator/merge-preview?packetId=${encodeURIComponent(packetId)}`, {
      acceptedErrorStatuses: [409],
    });
    const structuredError = preview && typeof preview === 'object'
      && 'error' in (preview as Record<string, unknown>);
    return structuredError
      ? { ...jsonResult(preview), isError: true }
      : jsonResult(preview);
  } catch (error) {
    console.error(`${'[mcp-operator]'} o8_merge_preview failed: ${errorText(error)}`);
    return textResult(`Failed to preview merge: ${errorText(error)}`, true);
  }
}
