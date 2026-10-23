import { resetPacket } from '@/lib/mcp/operator-mission-tools';
import { lifecycleErrorResult } from './lifecycle-error';
import { jsonResult, optionalString, requiredString, type McpToolResult } from './shared';

// F33 (#1025): reset_packet and retry_packet share an implementation but
// differ in semantics — reset implies "wipe and try again," retry implies
// "preserve and resume." When clearWorktree was uniformly defaulted to false,
// reset_packet without the explicit flag left orphan worktree dirs that
// collided with the next dispatch and produced -<suffix> duplicates on the
// same branch. Splitting the defaults keeps the two verbs honest.
async function doResetPacket(
  args: Record<string, unknown>,
  defaultClearWorktree: boolean,
): Promise<McpToolResult> {
  try {
    const clearWorktree = args.clearWorktree === undefined
      ? defaultClearWorktree
      : args.clearWorktree === true;
    const result = await resetPacket({
      packetId: requiredString(args, 'packetId'),
      reason: optionalString(args, 'reason') || undefined,
      clearWorktree,
    });
    if ('error' in result) return lifecycleErrorResult(defaultClearWorktree ? 'reset_packet' : 'retry_packet', result, args.packetId);
    return jsonResult(result);
  } catch (error) {
    return lifecycleErrorResult(defaultClearWorktree ? 'reset_packet' : 'retry_packet', error, args.packetId);
  }
}

export async function handleResetPacket(args: Record<string, unknown>): Promise<McpToolResult> {
  return doResetPacket(args, /* default clearWorktree */ true);
}

export async function handleRetryPacket(args: Record<string, unknown>): Promise<McpToolResult> {
  return doResetPacket(args, /* default clearWorktree */ false);
}
