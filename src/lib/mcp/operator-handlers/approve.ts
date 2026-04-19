import { approveAndMergePacket } from '@/lib/mcp/operator-mission-tools';
import { withSynchronousWorktreeCleanup } from '@/lib/orchestrator/worktree-cleanup';
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
    // #622 — wrapper guarantees synchronous worktree cleanup before return.
    const result = await withSynchronousWorktreeCleanup(packetId, () => approveAndMergePacket({ packetId, commitMessage: optionalString(args, 'commitMessage') || undefined }));
    return jsonResult(result);
  } catch (error) {
    console.error(`${'[mcp-operator]'} approve_and_merge failed: ${errorText(error)}`);
    return textResult(`Failed to approve and merge: ${errorText(error)}`, true);
  }
}
