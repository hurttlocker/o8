/**
 * `o8 packet reset | retry | rerun | merge-preview` — packet recovery verbs.
 *
 * CLI-as-control-plane symmetry (platform teardown #2, Stage 3). Thin clients of the
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
import { detectWorktree } from './worktree-resolve.js';
import {
  parsePacketArguments,
  requirePacketId,
  resolvePacketTarget,
  type ParsedPacketArguments,
} from './target.js';

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

type RecoveryVerb = 'reset' | 'retry' | 'rerun' | 'steer' | 'approve-merge' | 'merge-preview';

export function parsePacketRecoveryArgs(verb: RecoveryVerb, rest: string[]): ParsedPacketArguments {
  if (verb === 'reset' || verb === 'retry') {
    return parsePacketArguments(rest, { command: verb, valueFlags: ['reason'] });
  }
  if (verb === 'rerun') {
    return parsePacketArguments(rest, { command: verb, valueFlags: ['feedback'] });
  }
  if (verb === 'steer') {
    return parsePacketArguments(rest, { command: verb, valueFlags: ['message'] });
  }
  if (verb === 'approve-merge') {
    return parsePacketArguments(rest, {
      command: verb,
      valueFlags: ['commit-message', 'expected-sha', 'idempotency-key'],
      booleanFlags: ['as-operator'],
    });
  }
  return parsePacketArguments(rest, { command: verb });
}

function responseError(payload: OperatorResponse<unknown> | null | undefined, fallback: string): string {
  const error = payload?.error;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object' && typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

async function doReset(mode: OutputMode, rest: string[], clearWorktree: boolean, verb: 'reset' | 'retry'): Promise<number> {
  const args = parsePacketRecoveryArgs(verb, rest);
  const packetId = requirePacketId(await resolvePacketTarget(args.target), verb);
  const cfg = resolveConfig();
  const res = await apiFetch<OperatorResponse<unknown>>(cfg, '/api/orchestrator/reset-packet', {
    method: 'POST',
    body: { packetId, clearWorktree, reason: args.values.reason?.trim() || undefined },
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
  const args = parsePacketRecoveryArgs('rerun', rest);
  const feedback = args.values.feedback?.trim();
  if (!feedback) {
    throw new CliError(
      'invalid_args',
      'o8 packet rerun requires --feedback.',
      EXIT.INVALID_ARGS,
      'Example: o8 packet rerun --feedback "Typecheck failed on src/foo.ts:12 — fix the missing import."',
    );
  }
  const packetId = requirePacketId(await resolvePacketTarget(args.target), 'rerun');
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
  const args = parsePacketRecoveryArgs('merge-preview', rest);
  const packetId = requirePacketId(await resolvePacketTarget(args.target), 'merge-preview');
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
  const args = parsePacketRecoveryArgs('steer', rest);
  const message = args.values.message?.trim();
  if (!message) {
    throw new CliError(
      'invalid_args',
      'o8 packet steer requires --message.',
      EXIT.INVALID_ARGS,
      'Example: o8 packet steer --message "Also handle the empty-input case."',
    );
  }
  const packetId = requirePacketId(await resolvePacketTarget(args.target), 'steer');
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
  const args = parsePacketRecoveryArgs('approve-merge', rest);
  const packetId = requirePacketId(await resolvePacketTarget(args.target), 'approve-merge');
  const worker = isWorkerContext(args.booleans.has('as-operator') ? ['--as-operator'] : []);
  const cfg = resolveConfig();
  const res = await apiFetch<OperatorResponse<{ merged?: boolean; status?: string; approvalId?: string; note?: string }>>(cfg, '/api/orchestrator/merge', {
    method: 'POST',
    body: {
      packetId,
      commitMessage: args.values['commit-message']?.trim() || undefined,
      expectedHeadSha: args.values['expected-sha']?.trim() || undefined,
      idempotencyKey: args.values['idempotency-key']?.trim() || undefined,
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
