import { createHash } from 'node:crypto';

import type { PacketTaskContract } from '@/lib/orchestrator/types';

export type QualitySearchRole = 'minimal_complete' | 'robustness_complete';

export interface QualitySearchCandidateEvidence {
  packetId: string;
  role: QualitySearchRole;
  headSha: string | null;
  diffFingerprint: string | null;
  taskContractFingerprint: string | null;
  requirementCount: number;
  contractCoveragePassed: boolean;
  /**
   * Structured coverage verdict from the durable review gate. Selection must
   * distinguish "coverage incomplete" from "code is bad" — without these, a
   * candidate with one mis-cited production path is indistinguishable from a
   * rejected review, and targeted repair has nothing to aim at.
   */
  contractCoverageStatus: 'passed' | 'failed' | 'not-applicable' | 'unknown';
  missingRequirementIds: string[];
  coverageFailureReasons: string[];
  reviewApproved: boolean;
  reviewPinnedToHead: boolean;
  mergeGatePassed: boolean;
  failedChecks: string[];
  changedFiles: number;
  additions: number;
  deletions: number;
  newPublicSurfaces: number;
}

export interface QualitySearchSelectionReceipt {
  version: 1;
  createdAt: string;
  outcome: 'selected' | 'repair' | 'hold';
  contractFingerprint: string | null;
  selectedPacketId: string | null;
  repairPacketId: string | null;
  reason: string;
  candidates: QualitySearchCandidateEvidence[];
}

export interface QualitySearchPacketState {
  version: 1;
  role: QualitySearchRole | null;
  repairAttempts: number;
  receipt?: QualitySearchSelectionReceipt | null;
}

export interface QualitySearchSelection {
  outcome: QualitySearchSelectionReceipt['outcome'];
  selectedPacketId: string | null;
  repairPacketId: string | null;
  receipt: QualitySearchSelectionReceipt;
}

export const QUALITY_SEARCH_ROLES: readonly QualitySearchRole[] = [
  'minimal_complete',
  'robustness_complete',
];

function canonicalContract(contract: PacketTaskContract): string {
  return JSON.stringify({
    version: contract.version,
    requirements: contract.requirements.map((requirement) => ({
      id: requirement.id,
      source: requirement.source,
      expectedBehavior: requirement.expectedBehavior,
      productionPath: requirement.productionPath,
      verification: requirement.verification,
    })),
    smallestRoute: contract.smallestRoute.map((route) => ({
      path: route.path,
      requirements: route.requirements,
      reason: route.reason,
    })),
    exclusions: contract.exclusions,
  });
}

export function fingerprintQualitySearchContract(contract: PacketTaskContract): string {
  return createHash('sha256').update(canonicalContract(contract)).digest('hex');
}

export function normalizeQualitySearchPacketState(value: unknown): QualitySearchPacketState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<QualitySearchPacketState>;
  const role = raw.role === 'minimal_complete' || raw.role === 'robustness_complete'
    ? raw.role
    : null;
  const repairAttempts = typeof raw.repairAttempts === 'number'
    && Number.isFinite(raw.repairAttempts)
    && raw.repairAttempts >= 0
    ? Math.min(1, Math.floor(raw.repairAttempts))
    : 0;
  return {
    version: 1,
    role,
    repairAttempts,
    receipt: normalizeSelectionReceipt(raw.receipt),
  };
}

function normalizeCandidateEvidence(value: unknown): QualitySearchCandidateEvidence | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<QualitySearchCandidateEvidence>;
  if (!raw.packetId || (raw.role !== 'minimal_complete' && raw.role !== 'robustness_complete')) {
    return null;
  }
  const count = (entry: unknown) => (
    typeof entry === 'number' && Number.isFinite(entry) && entry >= 0 ? Math.floor(entry) : 0
  );
  return {
    packetId: raw.packetId,
    role: raw.role,
    headSha: typeof raw.headSha === 'string' && raw.headSha.trim() ? raw.headSha.trim() : null,
    diffFingerprint: typeof raw.diffFingerprint === 'string' && raw.diffFingerprint.trim()
      ? raw.diffFingerprint.trim()
      : null,
    taskContractFingerprint: typeof raw.taskContractFingerprint === 'string' && raw.taskContractFingerprint.trim()
      ? raw.taskContractFingerprint.trim()
      : null,
    requirementCount: count(raw.requirementCount),
    // Absent coverage normalizes to 'unknown', never to 'passed'. A field that
    // evaporates on round-trip must fail closed, not authorize a merge.
    contractCoverageStatus: raw.contractCoverageStatus === 'passed'
      || raw.contractCoverageStatus === 'failed'
      || raw.contractCoverageStatus === 'not-applicable'
      ? raw.contractCoverageStatus
      : 'unknown',
    missingRequirementIds: Array.isArray(raw.missingRequirementIds)
      ? raw.missingRequirementIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [],
    coverageFailureReasons: Array.isArray(raw.coverageFailureReasons)
      ? raw.coverageFailureReasons.filter((reason): reason is string => typeof reason === 'string' && reason.length > 0)
      : [],
    contractCoveragePassed: raw.contractCoveragePassed === true,
    reviewApproved: raw.reviewApproved === true,
    reviewPinnedToHead: raw.reviewPinnedToHead === true,
    mergeGatePassed: raw.mergeGatePassed === true,
    failedChecks: Array.isArray(raw.failedChecks)
      ? raw.failedChecks.map((entry) => String(entry).trim()).filter(Boolean).slice(0, 16)
      : [],
    changedFiles: count(raw.changedFiles),
    additions: count(raw.additions),
    deletions: count(raw.deletions),
    newPublicSurfaces: count(raw.newPublicSurfaces),
  };
}

function normalizeSelectionReceipt(value: unknown): QualitySearchSelectionReceipt | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<QualitySearchSelectionReceipt>;
  if (
    raw.version !== 1
    || (raw.outcome !== 'selected' && raw.outcome !== 'repair' && raw.outcome !== 'hold')
    || typeof raw.createdAt !== 'string'
    || typeof raw.reason !== 'string'
    || !Array.isArray(raw.candidates)
  ) {
    return null;
  }
  const candidates = raw.candidates.map(normalizeCandidateEvidence).filter((entry) => entry !== null);
  return {
    version: 1,
    createdAt: raw.createdAt,
    outcome: raw.outcome,
    contractFingerprint: typeof raw.contractFingerprint === 'string' ? raw.contractFingerprint : null,
    selectedPacketId: typeof raw.selectedPacketId === 'string' ? raw.selectedPacketId : null,
    repairPacketId: typeof raw.repairPacketId === 'string' ? raw.repairPacketId : null,
    reason: raw.reason,
    candidates,
  };
}

export function buildQualitySearchRolePrompt(role: QualitySearchRole): string {
  if (role === 'minimal_complete') {
    return [
      'Quality-search candidate role: smallest complete route.',
      'Implement every requirement in the sealed task contract through its real production path, while minimizing changed files, new public surface, and unrelated restructuring.',
      'Do not trade away required validation, tests, error handling, or recovery to make the diff smaller.',
    ].join('\n');
  }
  return [
    'Quality-search candidate role: robustness route.',
    'Implement every requirement in the sealed task contract through its real production path, and actively inspect boundary cases, failure recovery, state transitions, and cross-process seams that the smallest route could miss.',
    'Stay inside the contract and avoid speculative features or architecture work; robustness must be supported by executable evidence.',
  ].join('\n');
}

function candidateIsComplete(candidate: QualitySearchCandidateEvidence): boolean {
  return Boolean(candidate.taskContractFingerprint)
    && candidate.requirementCount > 0
    && candidate.contractCoveragePassed
    && candidate.reviewApproved
    && candidate.reviewPinnedToHead
    && candidate.mergeGatePassed
    && candidate.failedChecks.length === 0;
}

function minimalityTuple(candidate: QualitySearchCandidateEvidence): readonly number[] {
  return [
    candidate.newPublicSurfaces,
    candidate.changedFiles,
    candidate.additions + candidate.deletions,
    candidate.additions,
    candidate.deletions,
  ];
}

function compareNumberTuples(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function compareCompleteCandidates(
  left: QualitySearchCandidateEvidence,
  right: QualitySearchCandidateEvidence,
): number {
  const minimality = compareNumberTuples(minimalityTuple(left), minimalityTuple(right));
  if (minimality !== 0) return minimality;
  return left.packetId.localeCompare(right.packetId);
}

function compareRepairCandidates(
  left: QualitySearchCandidateEvidence,
  right: QualitySearchCandidateEvidence,
): number {
  const leftSignals = [
    left.contractCoveragePassed ? 1 : 0,
    left.reviewApproved ? 1 : 0,
    left.reviewPinnedToHead ? 1 : 0,
    left.mergeGatePassed ? 1 : 0,
    -left.failedChecks.length,
  ];
  const rightSignals = [
    right.contractCoveragePassed ? 1 : 0,
    right.reviewApproved ? 1 : 0,
    right.reviewPinnedToHead ? 1 : 0,
    right.mergeGatePassed ? 1 : 0,
    -right.failedChecks.length,
  ];
  const evidence = compareNumberTuples(rightSignals, leftSignals);
  if (evidence !== 0) return evidence;
  return compareCompleteCandidates(left, right);
}

export function selectQualitySearchCandidate(input: {
  candidates: QualitySearchCandidateEvidence[];
  repairAttempts: number;
  createdAt?: string;
}): QualitySearchSelection {
  const candidates = input.candidates
    .map((candidate) => normalizeCandidateEvidence(candidate))
    .filter((candidate) => candidate !== null)
    .sort((left, right) => left.packetId.localeCompare(right.packetId));
  const fingerprints = new Set(candidates.map((candidate) => candidate.taskContractFingerprint).filter(Boolean));
  const sharedContract = fingerprints.size === 1 && candidates.every((candidate) => candidate.taskContractFingerprint);
  const createdAt = input.createdAt ?? new Date().toISOString();

  let outcome: QualitySearchSelectionReceipt['outcome'];
  let selectedPacketId: string | null = null;
  let repairPacketId: string | null = null;
  let reason: string;

  if (candidates.length !== 2) {
    outcome = 'hold';
    reason = `Quality search requires exactly two candidates; received ${candidates.length}.`;
  } else if (!sharedContract) {
    outcome = 'hold';
    reason = 'Candidates were not generated from one identical sealed task contract.';
  } else {
    const complete = candidates.filter(candidateIsComplete).sort(compareCompleteCandidates);
    if (complete.length > 0) {
      outcome = 'selected';
      selectedPacketId = complete[0]!.packetId;
      reason = complete.length === 1
        ? 'Selected the only candidate with complete contract, review-head, and merge-gate evidence.'
        : 'Both candidates were complete; selected the lower-blast-radius candidate.';
    } else if (input.repairAttempts < 1) {
      outcome = 'repair';
      repairPacketId = [...candidates].sort(compareRepairCandidates)[0]!.packetId;
      reason = 'Neither candidate cleared the evidence filter; grant the closest candidate one targeted repair.';
    } else {
      outcome = 'hold';
      reason = 'Neither candidate cleared the evidence filter after the one-repair limit.';
    }
  }

  const receipt: QualitySearchSelectionReceipt = {
    version: 1,
    createdAt,
    outcome,
    contractFingerprint: sharedContract ? [...fingerprints][0] ?? null : null,
    selectedPacketId,
    repairPacketId,
    reason,
    candidates,
  };
  return { outcome, selectedPacketId, repairPacketId, receipt };
}
