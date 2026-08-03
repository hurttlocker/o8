import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { getLaneSpokenDiffFacts } from '@/lib/lane/lane-diff-facts';
import { buildPreviewForLane } from '@/lib/lane/preview-merge';
import { findLatestLaneByPacket } from '@/lib/lane/registry';
import { fingerprintQualitySearchContract } from '@/lib/orchestrator/quality-search-contract-fingerprint';
import {
  type QualitySearchCandidateEvidence,
  type QualitySearchRole,
} from '@/lib/orchestrator/quality-search';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const execFileAsync = promisify(execFile);

function parseNumstat(output: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [added, deleted] = line.split('\t');
    const addedCount = Number(added);
    const deletedCount = Number(deleted);
    if (Number.isFinite(addedCount) && addedCount > 0) additions += addedCount;
    if (Number.isFinite(deletedCount) && deletedCount > 0) deletions += deletedCount;
  }
  return { additions, deletions };
}

function countNewPublicSurfaces(changedFiles: string[], addedLines: string[]): number {
  const implementationFiles = changedFiles.filter((file) => (
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
    && !file.startsWith('tests/')
  ));
  const routeFiles = implementationFiles.filter((file) => (
    /(?:^|\/)route\.[cm]?[jt]s$/.test(file)
    || file.startsWith('cli/src/commands/')
    || file.startsWith('src/lib/mcp/')
  )).length;
  const exportedSymbols = addedLines.filter((line) => (
    /^\+\s*export\s+(?:default\s+)?(?:async\s+)?(?:class|const|enum|function|interface|type)\b/.test(line)
  )).length;
  return routeFiles + exportedSymbols;
}

function unavailableEvidence(packet: OrchestratorPacket, role: QualitySearchRole): QualitySearchCandidateEvidence {
  return {
    packetId: packet.id,
    role,
    headSha: null,
    diffFingerprint: null,
    taskContractFingerprint: packet.taskContract
      ? fingerprintQualitySearchContract(packet.taskContract)
      : null,
    requirementCount: packet.taskContract?.requirements.length ?? 0,
    contractCoveragePassed: false,
    contractCoverageStatus: 'unknown',
    missingRequirementIds: [],
    coverageFailureReasons: ['evidence-unavailable'],
    reviewApproved: packet.review?.approved === true,
    reviewPinnedToHead: false,
    mergeGatePassed: false,
    failedChecks: ['evidence-unavailable'],
    changedFiles: 0,
    additions: 0,
    deletions: 0,
    newPublicSurfaces: 0,
  };
}


interface CandidateCoverage {
  status: 'passed' | 'failed' | 'not-applicable' | 'unknown';
  missingRequirementIds: string[];
  failureReasons: string[];
}

/**
 * Read the durable review gate's structured coverage verdict for this lane.
 * Never synthesizes a verdict: an unreadable gate reports `unknown`, which is
 * not the same as `passed` and must never be treated as one.
 */
async function readDurableContractCoverage(
  lane: Parameters<typeof getLaneSpokenDiffFacts>[0],
): Promise<CandidateCoverage> {
  try {
    const { assessDurableApprovedReview } = await import('@/lib/lane/durable-review-approval');
    const assessment = await assessDurableApprovedReview(lane);
    const coverage = assessment.contractCoverage;
    if (!coverage) return { status: 'not-applicable', missingRequirementIds: [], failureReasons: [] };
    return {
      status: coverage.status,
      missingRequirementIds: coverage.missingRequirementIds,
      failureReasons: Array.from(new Set(
        coverage.checks
          .map((check) => check.failureReason)
          .filter((reason): reason is NonNullable<typeof reason> => reason !== null),
      )),
    };
  } catch {
    return { status: 'unknown', missingRequirementIds: [], failureReasons: ['coverage-unreadable'] };
  }
}

export async function collectQualitySearchCandidateEvidence(
  packet: OrchestratorPacket,
): Promise<QualitySearchCandidateEvidence> {
  const role = packet.qualitySearch?.role;
  if (role !== 'minimal_complete' && role !== 'robustness_complete') {
    throw new Error(`Packet ${packet.id} has no quality-search candidate role.`);
  }
  const lane = findLatestLaneByPacket(packet.id);
  if (!lane) return unavailableEvidence(packet, role);

  try {
    const [facts, preview] = await Promise.all([
      getLaneSpokenDiffFacts(lane),
      buildPreviewForLane(lane, packet.id, { orchestratorApproved: packet.review?.approved === true }),
    ]);
    const { stdout: numstatOutput } = await execFileAsync(
      'git',
      ['diff', '--numstat', facts.against],
      {
        cwd: lane.worktreePath || lane.repoPath,
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const numstat = parseNumstat(numstatOutput);
    const coverage = await readDurableContractCoverage(lane);
    const reviewApproved = packet.review?.approved === true;
    const reviewPinnedToHead = reviewApproved
      && Boolean(packet.review?.reviewedHeadSha)
      && packet.review?.reviewedHeadSha === facts.headSha;
    return {
      packetId: packet.id,
      role,
      headSha: facts.headSha,
      diffFingerprint: facts.fingerprint,
      taskContractFingerprint: packet.taskContract
        ? fingerprintQualitySearchContract(packet.taskContract)
        : null,
      requirementCount: packet.taskContract?.requirements.length ?? 0,
      // The durable review gate is the authority for structured contract
      // coverage. Selection never infers coverage from diff size or worker prose,
      // and never from review approval alone — approval and coverage are
      // different signals and are reported separately.
      contractCoveragePassed: coverage.status === 'passed' || coverage.status === 'not-applicable',
      contractCoverageStatus: coverage.status,
      missingRequirementIds: coverage.missingRequirementIds,
      coverageFailureReasons: coverage.failureReasons,
      reviewApproved,
      reviewPinnedToHead,
      mergeGatePassed: preview.wouldMerge,
      failedChecks: preview.blockers,
      changedFiles: facts.changedFiles.length,
      additions: numstat.additions,
      deletions: numstat.deletions,
      newPublicSurfaces: countNewPublicSurfaces(facts.changedFiles, facts.addedLines),
    };
  } catch {
    return unavailableEvidence(packet, role);
  }
}

export const qualitySearchEvidenceInternals = {
  countNewPublicSurfaces,
  parseNumstat,
};
