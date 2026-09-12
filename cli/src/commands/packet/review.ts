import { randomUUID } from 'node:crypto';
import { CliError, EXIT } from '../../api.js';
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
import { fetchCorrelatedPacketMutation } from './correlated-mutation.js';

interface ReviewArgs {
  packetId: string | null;
  approve: boolean;
  expectedHeadSha: string | null;
  commitMessage: string | null;
  idempotencyKey: string | null;
  contractVersion: number | null;
  coverageEntries: Array<{
    requirementId: string;
    productionPath: string;
  }>;
}

interface OperatorResponse<T> {
  ok: boolean;
  result?: T;
  error?: { message?: string } | string;
}

function parseReviewArgs(rest: string[]): ReviewArgs {
  const args = parsePacketArguments(rest, {
    command: 'review',
    valueFlags: ['expected-sha', 'commit-message', 'idempotency-key', 'contract-version'],
    repeatableValueFlags: ['coverage'],
    booleanFlags: ['approve'],
  });

  const rawContractVersion = args.values['contract-version']?.trim();
  if (rawContractVersion && !/^\d+$/.test(rawContractVersion)) {
    throw new CliError('invalid_args', '--contract-version must be a positive integer.', EXIT.INVALID_ARGS);
  }
  const contractVersion = rawContractVersion ? Number.parseInt(rawContractVersion, 10) : null;
  if (contractVersion !== null && contractVersion < 1) {
    throw new CliError('invalid_args', '--contract-version must be a positive integer.', EXIT.INVALID_ARGS);
  }

  const seenRequirementIds = new Set<string>();
  const coverageEntries = (args.multiValues.coverage ?? []).map((entry) => {
    const separator = entry.indexOf('=');
    const requirementId = separator >= 0 ? entry.slice(0, separator).trim() : '';
    const productionPath = separator >= 0 ? entry.slice(separator + 1).trim() : '';
    if (!requirementId || !productionPath) {
      throw new CliError(
        'invalid_args',
        '--coverage must use <requirement-id>=<repo-relative-production-path>.',
        EXIT.INVALID_ARGS,
      );
    }
    if (seenRequirementIds.has(requirementId)) {
      throw new CliError(
        'invalid_args',
        `--coverage repeats requirement ${requirementId}.`,
        EXIT.INVALID_ARGS,
      );
    }
    seenRequirementIds.add(requirementId);
    return { requirementId, productionPath };
  });

  if (contractVersion !== null && coverageEntries.length === 0) {
    throw new CliError(
      'invalid_args',
      '--contract-version requires at least one --coverage entry.',
      EXIT.INVALID_ARGS,
    );
  }

  return {
    packetId: args.target,
    approve: args.booleans.has('approve'),
    expectedHeadSha: args.values['expected-sha']?.trim() || null,
    commitMessage: args.values['commit-message']?.trim() || null,
    idempotencyKey: args.values['idempotency-key']?.trim() || null,
    contractVersion,
    coverageEntries,
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
  if (args.coverageEntries.length > 0 && !args.expectedHeadSha) {
    throw new CliError(
      'invalid_args',
      '--coverage requires --expected-sha so the evidence is bound to the reviewed commit.',
      EXIT.INVALID_ARGS,
      'Pass the full output of `git rev-parse HEAD` with --expected-sha.',
    );
  }
  if (args.coverageEntries.length > 0 && !/^[0-9a-f]{40}$/i.test(args.expectedHeadSha ?? '')) {
    throw new CliError(
      'invalid_args',
      '--coverage requires a full 40-character commit SHA in --expected-sha.',
      EXIT.INVALID_ARGS,
      'Pass the full output of `git rev-parse HEAD` with --expected-sha.',
    );
  }
  const cfg = resolveConfig();
  const receiptKey = args.idempotencyKey ?? randomUUID();
  const reviewRes = await fetchCorrelatedPacketMutation<OperatorResponse<{
    recorded: boolean;
    reviewedHeadSha?: string | null;
    inProgress?: boolean;
    status?: string;
    note?: string;
    contractCoverage?: {
      status: 'passed' | 'failed' | 'not-applicable';
      reason: string;
      checks: Array<{
        requirementId: string;
        covered: boolean;
        citedPath: string | null;
      }>;
      missingRequirementIds: string[];
    } | null;
  }>>(cfg, '/api/orchestrator/review', {
    packetId,
    approved: true,
    findings: [],
    reviewedHeadSha: args.expectedHeadSha ?? undefined,
    contractCoverageEvidence: args.coverageEntries.length > 0 ? {
      contractVersion: args.contractVersion ?? 1,
      headSha: args.expectedHeadSha!,
      entries: args.coverageEntries,
    } : undefined,
    clientMutationId: receiptKey,
  });
  if (!reviewRes.data?.ok) {
    throw new CliError('review_failed', responseError(reviewRes.data, 'Packet review was rejected.'), EXIT.CONFLICT);
  }
  const reviewResult = reviewRes.data.result;
  if (!reviewResult) {
    throw new CliError('review_failed', 'Packet review returned no result.', EXIT.CONFLICT);
  }
  if (reviewResult.contractCoverage?.status === 'failed') {
    throw new CliError(
      'contract_coverage_failed',
      reviewResult.contractCoverage.reason,
      EXIT.CONFLICT,
      'Repeat --coverage <requirement-id>=<repo-relative-production-path> for every sealed requirement.',
    );
  }

  const mergeBody = {
    packetId,
    commitMessage: args.commitMessage ?? undefined,
    expectedHeadSha: args.expectedHeadSha ?? undefined,
    idempotencyKey: receiptKey,
  };
  const mergeRes = await fetchCorrelatedPacketMutation<OperatorResponse<{
    merged?: boolean;
    note?: string;
    inProgress?: boolean;
    status?: string;
    currentHeadSha?: string;
    expectedHeadSha?: string;
  }>>(cfg, '/api/orchestrator/merge', mergeBody);
  if (!mergeRes.data?.ok || !mergeRes.data.result) {
    throw new CliError('merge_failed', responseError(mergeRes.data, 'Packet merge was rejected.'), EXIT.CONFLICT);
  }
  const mergeInProgress = mergeRes.status === 202
    || mergeRes.data.result.inProgress === true
    || mergeRes.data.result.status === 'in_progress';

  const payload = {
    schema: 'o8/cli/packet.review/v1',
    packet: {
      id: packetId,
      approved: true,
      reviewedHeadSha: reviewResult.reviewedHeadSha ?? args.expectedHeadSha,
      contractCoverage: reviewResult.contractCoverage ?? null,
      mergeInProgress,
      merge: mergeRes.data.result,
    },
  };

  if (mode.human) {
    printHumanHeading('packet review');
    printHumanKv([
      ['packet', packetId],
      ['approved', 'yes'],
      ['reviewed HEAD', payload.packet.reviewedHeadSha ?? '(captured by server)'],
      ['contract coverage', payload.packet.contractCoverage
        ? `${payload.packet.contractCoverage.status}: ${payload.packet.contractCoverage.reason}`
        : 'not required'],
      ['coverage checks', payload.packet.contractCoverage?.checks
        .map((check) => `${check.requirementId}=${check.covered ? 'covered' : 'missing'}${check.citedPath ? ` (${check.citedPath})` : ''}`)
        .join(', ') ?? ''],
      ['merged', mergeInProgress ? 'already in progress (not merged twice)' : mergeRes.data.result.merged ? 'yes' : 'no'],
      ['note', mergeRes.data.result.note ?? ''],
    ]);
  } else {
    printJson(payload);
  }

  return 0;
}
