import { apiFetch, CliError, EXIT, SLOW_MUTATION_TIMEOUT_MS } from '../../api.js';
import { resolveConfig } from '../../config.js';
import {
  printHumanHeading,
  printHumanKv,
  printJson,
  type OutputMode,
} from '../../output.js';
import {
  parsePacketArguments,
  requirePacketId,
  resolvePacketTarget,
} from './target.js';

interface ReviewArgs {
  packetId: string | null;
  approve: boolean;
  expectedHeadSha: string | null;
  commitMessage: string | null;
}

interface OperatorResponse<T> {
  ok: boolean;
  result?: T;
  error?: { message?: string } | string;
}

function parseReviewArgs(rest: string[]): ReviewArgs {
  const args = parsePacketArguments(rest, {
    command: 'review',
    valueFlags: ['expected-sha', 'commit-message'],
    booleanFlags: ['approve'],
  });

  return {
    packetId: args.target,
    approve: args.booleans.has('approve'),
    expectedHeadSha: args.values['expected-sha']?.trim() || null,
    commitMessage: args.values['commit-message']?.trim() || null,
  };
}

function responseError(payload: OperatorResponse<unknown> | null | undefined, fallback: string) {
  const error = payload?.error;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object' && typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

export async function runPacketReview(mode: OutputMode, rest: string[]): Promise<number> {
  const args = parseReviewArgs(rest);
  if (!args.approve) {
    throw new CliError(
      'invalid_args',
      'o8 packet review currently requires --approve.',
      EXIT.INVALID_ARGS,
      'Example: o8 packet review --approve --expected-sha $(git rev-parse HEAD)',
    );
  }

  const packetId = requirePacketId(await resolvePacketTarget(args.packetId), 'review');
  const cfg = resolveConfig();
  const reviewRes = await apiFetch<OperatorResponse<{
    recorded: boolean;
    reviewedHeadSha?: string | null;
  }>>(cfg, '/api/orchestrator/review', {
    method: 'POST',
    body: {
      packetId,
      approved: true,
      findings: [],
      reviewedHeadSha: args.expectedHeadSha ?? undefined,
    },
  });
  if (!reviewRes.data?.ok) {
    throw new CliError('review_failed', responseError(reviewRes.data, 'Packet review was rejected.'), EXIT.CONFLICT);
  }
  const reviewResult = reviewRes.data.result;
  if (!reviewResult) {
    throw new CliError('review_failed', 'Packet review returned no result.', EXIT.CONFLICT);
  }

  const mergeRes = await apiFetch<OperatorResponse<{
    merged: boolean;
    note: string;
    currentHeadSha?: string;
    expectedHeadSha?: string;
  }>>(cfg, '/api/orchestrator/merge', {
    method: 'POST',
    timeoutMs: SLOW_MUTATION_TIMEOUT_MS,
    body: {
      packetId,
      commitMessage: args.commitMessage ?? undefined,
      expectedHeadSha: args.expectedHeadSha ?? undefined,
    },
  });
  if (!mergeRes.data?.ok || !mergeRes.data.result) {
    throw new CliError('merge_failed', responseError(mergeRes.data, 'Packet merge was rejected.'), EXIT.CONFLICT);
  }

  const payload = {
    schema: 'o8/cli/packet.review/v1',
    packet: {
      id: packetId,
      approved: true,
      reviewedHeadSha: reviewResult.reviewedHeadSha ?? args.expectedHeadSha,
      merge: mergeRes.data.result,
    },
  };

  if (mode.human) {
    printHumanHeading('packet review');
    printHumanKv([
      ['packet', packetId],
      ['approved', 'yes'],
      ['reviewed HEAD', payload.packet.reviewedHeadSha ?? '(captured by server)'],
      ['merged', mergeRes.data.result.merged ? 'yes' : 'no'],
      ['note', mergeRes.data.result.note],
    ]);
  } else {
    printJson(payload);
  }

  return 0;
}
