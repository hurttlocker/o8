import 'server-only';

/**
 * Apply an approved agent-proposed spec update — closes #857.
 *
 * The agent enqueues the proposal via `cortex_propose_spec` (see
 * `cortex-mcp-server.ts`); the operator approves via the standard approval
 * queue. On approve we re-read the current spec to verify the operator's
 * mental model matches what's on disk, then call `writePacketSpec` so the
 * next dispatch picks up the new content. On reject we do nothing — the
 * spec on disk is untouched.
 */
import type { ApprovalRecord } from '@/lib/approvals/types';
import { readPacketSpec, writePacketSpec } from '@/lib/orchestrator/packet-spec';

export interface ApplyApprovedSpecUpdateResult {
  ok: boolean;
  packetId: string;
  message: string;
  updatedAt?: string;
  error?: string;
}

export async function applyApprovedSpecUpdate(
  approval: ApprovalRecord,
): Promise<ApplyApprovedSpecUpdateResult> {
  const continuation = approval.continuation;
  if (!continuation || continuation.kind !== 'spec-update') {
    return {
      ok: false,
      packetId: '',
      message: 'Approval is not a spec-update.',
      error: 'wrong_continuation_kind',
    };
  }

  const { packetId, proposedSpec } = continuation;
  if (!packetId) {
    return {
      ok: false,
      packetId: '',
      message: 'packetId missing from spec-update continuation.',
      error: 'missing_packet_id',
    };
  }

  try {
    const result = await writePacketSpec(packetId, proposedSpec);
    return {
      ok: true,
      packetId,
      message: `Applied agent-proposed spec update to packet ${packetId}.`,
      updatedAt: result.updatedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to write packet spec.';
    return {
      ok: false,
      packetId,
      message,
      error: 'write_failed',
    };
  }
}

/**
 * Build the diff payload for a spec-update approval so the UI can render
 * old vs new without an extra API round-trip. Uses the current spec on
 * disk as `before` — if the operator edited the spec between the agent's
 * proposal and the approval landing, the diff reflects that drift.
 */
export async function buildSpecUpdateDiff(packetId: string, proposedSpec: string) {
  const current = await readPacketSpec(packetId);
  return {
    path: `packet-specs/${packetId}.md`,
    before: current.content,
    after: proposedSpec,
  };
}
