/**
 * `o8 packet reset | retry | rerun | merge-preview` — packet recovery verbs.
 *
 * CLI-as-control-plane symmetry (Orca teardown #2, Stage 3). Thin clients of the
 * gated /api/orchestrator/{reset-packet,rerun-with-feedback,merge-preview}
 * routes — the same routes the operator MCP server's reset_packet / retry_packet
 * / rerun_with_feedback / o8_merge_preview tools call. packetId resolves from
 * --packet or the current packet worktree.
 *
 *   o8 packet reset   [--packet <id>] [--reason "…"]   # wipe worktree, then `o8 mission dispatch`
 *   o8 packet retry   [--packet <id>] [--reason "…"]   # KEEP worktree, then `o8 mission dispatch`
 *   o8 packet rerun   --feedback "…" [--packet <id>]   # fresh worker w/ feedback (relaunches)
 *   o8 packet merge-preview [--packet <id>]            # dry-run the 5-layer merge gate
 */

import { apiFetch, CliError, EXIT } from '../../api.js';
import { resolveConfig } from '../../config.js';
import {
  printHumanHeading,
  printHumanKv,
  printJson,
  type OutputMode,
} from '../../output.js';
import { detectWorktree, resolveLaneFromCwd } from './worktree-resolve.js';

interface OperatorResponse<T> {
  ok: boolean;
  result?: T;
  error?: { message?: string } | string;
}

interface MergePreviewResult {
  packetId: string;
  wouldMerge: boolean;
  checks?: Array<{ name?: string; passed?: boolean; detail?: string }>;
  blockers?: string[];
  branch?: string;
  error?: string;
}

function flag(rest: string[], name: string): string | null {
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === `--${name}`) return rest[i + 1] ?? '';
    if (tok.startsWith(`--${name}=`)) return tok.slice(name.length + 3);
  }
  return null;
}

function responseError(payload: OperatorResponse<unknown> | null | undefined, fallback: string): string {
  const error = payload?.error;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object' && typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

async function resolvePacketId(explicit: string | null): Promise<string> {
  if (explicit?.trim()) return explicit.trim();
  const resolved = await resolveLaneFromCwd();
  if (!resolved?.packetId) {
    throw new CliError(
      'not_in_packet_worktree',
      'No packet id given and the current directory is not inside a packet worktree.',
      EXIT.NOT_FOUND,
      'Pass --packet <id> or run from a `.cortex-worktrees/packet-<id>` worktree.',
    );
  }
  return resolved.packetId;
}

async function doReset(mode: OutputMode, rest: string[], clearWorktree: boolean, verb: 'reset' | 'retry'): Promise<number> {
  const packetId = await resolvePacketId(flag(rest, 'packet'));
  const cfg = resolveConfig();
  const res = await apiFetch<OperatorResponse<unknown>>(cfg, '/api/orchestrator/reset-packet', {
    method: 'POST',
    body: { packetId, clearWorktree, reason: flag(rest, 'reason')?.trim() || undefined },
  });
  if (!res.data?.ok) {
    throw new CliError(`${verb}_failed`, responseError(res.data, `Packet ${verb} was rejected.`), EXIT.CONFLICT);
  }
  const payload = {
    schema: `o8/cli/packet.${verb}/v1`,
    packet: { id: packetId, clearWorktree, result: res.data.result },
    next: 'Run `o8 mission dispatch` to relaunch the packet.',
  };
  if (mode.human) {
    printHumanHeading(`packet ${verb}`);
    printHumanKv([
      ['packet', packetId],
      ['worktree', clearWorktree ? 'wiped' : 'preserved'],
      ['next', 'o8 mission dispatch'],
    ]);
  } else {
    printJson(payload);
  }
  return 0;
}

async function runPacketRerun(mode: OutputMode, rest: string[]): Promise<number> {
  const feedback = flag(rest, 'feedback')?.trim();
  if (!feedback) {
    throw new CliError(
      'invalid_args',
      'o8 packet rerun requires --feedback.',
      EXIT.INVALID_ARGS,
      'Example: o8 packet rerun --feedback "Typecheck failed on src/foo.ts:12 — fix the missing import."',
    );
  }
  const packetId = await resolvePacketId(flag(rest, 'packet'));
  const cfg = resolveConfig();
  const res = await apiFetch<OperatorResponse<unknown>>(cfg, '/api/orchestrator/rerun-with-feedback', {
    method: 'POST',
    body: { packetId, feedback },
  });
  if (!res.data?.ok) {
    throw new CliError('rerun_failed', responseError(res.data, 'Packet rerun was rejected.'), EXIT.CONFLICT);
  }
  const payload = { schema: 'o8/cli/packet.rerun/v1', packet: { id: packetId, result: res.data.result } };
  if (mode.human) {
    printHumanHeading('packet rerun');
    printHumanKv([['packet', packetId], ['feedback', feedback.slice(0, 60) + (feedback.length > 60 ? '…' : '')], ['relaunched', 'yes']]);
  } else {
    printJson(payload);
  }
  return 0;
}

async function runPacketMergePreview(mode: OutputMode, rest: string[]): Promise<number> {
  const packetId = await resolvePacketId(flag(rest, 'packet'));
  const cfg = resolveConfig();
  // merge-preview returns the raw MergePreviewResult (not the {ok,result} envelope).
  const res = await apiFetch<MergePreviewResult>(cfg, '/api/orchestrator/merge-preview', {
    query: { packetId },
  });
  const preview = res.data;
  if (!preview || preview.error) {
    throw new CliError('merge_preview_failed', preview?.error || 'Merge preview failed.', EXIT.CONFLICT);
  }
  const payload = { schema: 'o8/cli/packet.merge-preview/v1', preview };
  if (mode.human) {
    printHumanHeading('merge preview');
    printHumanKv([
      ['packet', preview.packetId],
      ['would merge', preview.wouldMerge ? 'yes' : 'no'],
      ['branch', preview.branch ?? '(unknown)'],
      ['blockers', preview.blockers?.length ? preview.blockers.join(', ') : '(none)'],
    ]);
  } else {
    printJson(payload);
  }
  // Not an error when wouldMerge=false — it's a verdict. Caller branches on the field.
  return 0;
}

async function runPacketSteer(mode: OutputMode, rest: string[]): Promise<number> {
  const message = flag(rest, 'message')?.trim();
  if (!message) {
    throw new CliError(
      'invalid_args',
      'o8 packet steer requires --message.',
      EXIT.INVALID_ARGS,
      'Example: o8 packet steer --message "Also handle the empty-input case."',
    );
  }
  const packetId = await resolvePacketId(flag(rest, 'packet'));
  const cfg = resolveConfig();
  const res = await apiFetch<OperatorResponse<{ laneId?: string; note?: string }>>(cfg, '/api/orchestrator/steer-packet', {
    method: 'POST',
    body: { packetId, message },
  });
  if (!res.data?.ok) {
    throw new CliError('steer_failed', responseError(res.data, 'Packet steer was rejected.'), EXIT.CONFLICT);
  }
  const payload = { schema: 'o8/cli/packet.steer/v1', packet: { id: packetId, result: res.data.result } };
  if (mode.human) {
    printHumanHeading('packet steer');
    printHumanKv([['packet', packetId], ['lane', res.data.result?.laneId ?? '?'], ['note', res.data.result?.note ?? 'steered']]);
  } else {
    printJson(payload);
  }
  return 0;
}

// Worker context: a dispatched worker runs inside a packet worktree (or carries
// O8_WORKER_PACKET_ID, stamped at dispatch). The CLI honestly reports this so the
// merge route raises an operator approval card instead of merging — the moat.
// `--as-operator` is the escape hatch for an operator working inside a worktree.
function isWorkerContext(rest: string[]): boolean {
  if (rest.includes('--as-operator')) return false;
  if (process.env.O8_WORKER_PACKET_ID) return true;
  return detectWorktree(process.cwd()) !== null;
}

async function runPacketApproveMerge(mode: OutputMode, rest: string[]): Promise<number> {
  const packetId = await resolvePacketId(flag(rest, 'packet'));
  const worker = isWorkerContext(rest);
  const cfg = resolveConfig();
  const res = await apiFetch<OperatorResponse<{ merged?: boolean; status?: string; approvalId?: string; note?: string }>>(cfg, '/api/orchestrator/merge', {
    method: 'POST',
    body: {
      packetId,
      commitMessage: flag(rest, 'commit-message')?.trim() || undefined,
      expectedHeadSha: flag(rest, 'expected-sha')?.trim() || undefined,
      idempotencyKey: flag(rest, 'idempotency-key')?.trim() || undefined,
      ...(worker ? { requestedByWorker: true } : {}),
    },
  });
  if (!res.data?.ok) {
    throw new CliError('merge_failed', responseError(res.data, 'Merge was rejected.'), EXIT.CONFLICT);
  }
  const result = res.data.result;
  const pending = result?.status === 'pending_operator_approval';
  const payload = {
    schema: 'o8/cli/packet.approve-merge/v1',
    packet: { id: packetId },
    context: worker ? 'worker' : 'operator',
    pending,
    result,
  };
  if (mode.human) {
    printHumanHeading('packet approve-merge');
    if (pending) {
      printHumanKv([
        ['packet', packetId],
        ['context', 'worker'],
        ['status', 'pending operator approval'],
        ['approval', result?.approvalId ?? '?'],
        ['next', 'operator: o8 inbox approve ' + (result?.approvalId ?? '<id>')],
      ]);
    } else {
      printHumanKv([['packet', packetId], ['merged', result?.merged ? 'yes' : 'no'], ['note', result?.note ?? '']]);
    }
  } else {
    printJson(payload);
  }
  return 0;
}

export async function runPacketReset(mode: OutputMode, rest: string[]): Promise<number> {
  return doReset(mode, rest, true, 'reset');
}

export async function runPacketRetry(mode: OutputMode, rest: string[]): Promise<number> {
  return doReset(mode, rest, false, 'retry');
}

export { runPacketRerun, runPacketMergePreview, runPacketSteer, runPacketApproveMerge };
