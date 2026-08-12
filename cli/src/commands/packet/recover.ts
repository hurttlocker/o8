/**
 * `o8 packet reset | retry | rerun | merge-preview` — packet recovery verbs.
 *
 * CLI-as-control-plane symmetry (Stage 3). Thin clients of the
 * gated /api/orchestrator/{reset-packet,rerun-with-feedback,merge-preview}
 * routes — the same routes the operator MCP server's reset_packet / retry_packet
 * / rerun_with_feedback / o8_merge_preview tools call. packetId resolves from
 * --packet or the current packet worktree.
 *
 *   o8 packet reset   [--packet <id>] [--reason "…"]   # wipe worktree, then `o8 mission dispatch`
 *   o8 packet retry   [--packet <id>] [--reason "…"]   # KEEP worktree; committed work returns to review
 *   o8 packet rerun   --feedback "…" [--packet <id>] [--idempotency-key <id>]
 *   o8 packet merge-preview [--packet <id>]            # dry-run the 5-layer merge gate
 */

import { randomUUID } from 'node:crypto';

import { apiFetch, CliError, EXIT, SLOW_MUTATION_TIMEOUT_MS } from '../../api.js';
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
import { fetchCorrelatedPacketMutation } from './correlated-mutation.js';

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

interface PacketResetResult {
  reset?: boolean;
  salvaged?: boolean;
  partial?: boolean;
  worktreePruned?: boolean;
  note?: string;
}

interface InProgressReceipt {
  inProgress?: boolean;
  status?: string;
  note?: string;
}

type RecoveryVerb = 'reset' | 'retry' | 'rerun' | 'steer' | 'approve-merge' | 'merge-preview';

export function parsePacketRecoveryArgs(verb: RecoveryVerb, rest: string[]): ParsedPacketArguments {
  if (verb === 'reset' || verb === 'retry') {
    return parsePacketArguments(rest, { command: verb, valueFlags: ['reason', 'idempotency-key'] });
  }
  if (verb === 'rerun') {
    return parsePacketArguments(rest, { command: verb, valueFlags: ['feedback', 'idempotency-key'] });
  }
  if (verb === 'steer') {
    return parsePacketArguments(rest, { command: verb, valueFlags: ['message', 'idempotency-key'] });
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
  const body = {
    packetId,
    clearWorktree,
    reason: args.values.reason?.trim() || undefined,
    idempotencyKey: args.values['idempotency-key']?.trim() || randomUUID(),
  };
  const res = await fetchCorrelatedPacketMutation<OperatorResponse<PacketResetResult>>(
    cfg,
    '/api/orchestrator/reset-packet',
    body,
    { timeoutMs: SLOW_MUTATION_TIMEOUT_MS },
  );
  if (!res.data?.ok) {
    throw new CliError(`${verb}_failed`, responseError(res.data, `Packet ${verb} was rejected.`), EXIT.CONFLICT);
  }
  if (res.data.result?.reset === false && res.data.result.salvaged !== true) {
    throw new CliError(`${verb}_failed`, res.data.result.note || `Packet ${verb} was not applied.`, EXIT.CONFLICT);
  }
  const salvaged = verb === 'retry' && res.data.result?.salvaged === true;
  const next = salvaged
    ? 'The preserved committed work is awaiting review; do not redispatch it.'
    : 'Run `o8 mission dispatch` to relaunch the packet.';
  const payload = {
    schema: `o8/cli/packet.${verb}/v1`,
    packet: { id: packetId, clearWorktree, result: res.data.result },
    next,
  };
  if (mode.human) {
    const worktreeState = !clearWorktree
      ? 'preserved'
      : res.data.result?.worktreePruned
        ? 'wiped'
        : 'already clear';
    printHumanHeading(`packet ${verb}`);
    printHumanKv([
      ['packet', packetId],
      ['worktree', worktreeState],
      ['next', salvaged ? 'review packet' : 'o8 mission dispatch'],
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
  const requestBody = {
    packetId,
    feedback,
    idempotencyKey: args.values['idempotency-key']?.trim() || randomUUID(),
  };
  const res = await fetchCorrelatedPacketMutation<OperatorResponse<InProgressReceipt>>(
    cfg,
    '/api/orchestrator/rerun-with-feedback',
    requestBody,
  );
  if (!res.data?.ok) {
    throw new CliError('rerun_failed', responseError(res.data, 'Packet rerun was rejected.'), EXIT.CONFLICT);
  }
  const inProgress = res.status === 202
    || res.data.result?.inProgress === true
    || res.data.result?.status === 'in_progress';
  const payload = {
    schema: 'o8/cli/packet.rerun/v1',
    inProgress,
    packet: { id: packetId, result: res.data.result },
  };
  if (mode.human) {
    printHumanHeading('packet rerun');
    printHumanKv([
      ['packet', packetId],
      ['feedback', feedback.slice(0, 60) + (feedback.length > 60 ? '…' : '')],
      ['status', inProgress ? 'already in progress (not relaunched twice)' : 'relaunched'],
    ]);
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
  const requestBody = {
    packetId,
    message,
    idempotencyKey: args.values['idempotency-key']?.trim() || randomUUID(),
  };
  const res = await fetchCorrelatedPacketMutation<OperatorResponse<InProgressReceipt & { laneId?: string }>>(
    cfg,
    '/api/orchestrator/steer-packet',
    requestBody,
  );
  if (!res.data?.ok) {
    throw new CliError('steer_failed', responseError(res.data, 'Packet steer was rejected.'), EXIT.CONFLICT);
  }
  const inProgress = res.status === 202
    || res.data.result?.inProgress === true
    || res.data.result?.status === 'in_progress';
  const payload = {
    schema: 'o8/cli/packet.steer/v1',
    inProgress,
    packet: { id: packetId, result: res.data.result },
  };
  if (mode.human) {
    printHumanHeading('packet steer');
    printHumanKv([
      ['packet', packetId],
      ['lane', res.data.result?.laneId ?? '?'],
      ['status', inProgress ? 'already in progress (not steered twice)' : 'steered'],
      ['note', res.data.result?.note ?? ''],
    ]);
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
  const requestBody = {
    packetId,
    commitMessage: args.values['commit-message']?.trim() || undefined,
    expectedHeadSha: args.values['expected-sha']?.trim() || undefined,
    idempotencyKey: args.values['idempotency-key']?.trim() || randomUUID(),
    ...(worker ? { requestedByWorker: true } : {}),
  };
  const res = await fetchCorrelatedPacketMutation<OperatorResponse<InProgressReceipt & { merged?: boolean; approvalId?: string }>>(
    cfg,
    '/api/orchestrator/merge',
    requestBody,
  );
  if (!res.data?.ok) {
    throw new CliError('merge_failed', responseError(res.data, 'Merge was rejected.'), EXIT.CONFLICT);
  }
  const result = res.data.result;
  const pending = result?.status === 'pending_operator_approval';
  const inProgress = res.status === 202 || result?.inProgress === true || result?.status === 'in_progress';
  const payload = {
    schema: 'o8/cli/packet.approve-merge/v1',
    packet: { id: packetId },
    context: worker ? 'worker' : 'operator',
    pending,
    inProgress,
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
    } else if (inProgress) {
      printHumanKv([
        ['packet', packetId],
        ['status', 'already in progress (not merged twice)'],
        ['note', result?.note ?? ''],
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
