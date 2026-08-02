/**
 * Deterministic task-contract coverage gate.
 *
 * A sealed task contract enumerates requirements before any edit is made. This
 * module decides, mechanically, whether a review actually proved each of those
 * requirements at the HEAD it reviewed. It is the authority behind durable
 * approval: if coverage fails, no non-user merge may proceed.
 *
 * The check is deliberately dumb. It does not read prose, judge quality, or ask
 * a model anything — it verifies that the review recorded evidence for every
 * requirement id, that the evidence cites a production path the change actually
 * touched, and that the evidence is bound to both the contract version and the
 * reviewed commit. Anything softer than that is an assertion, not a gate, and a
 * gate built on assertions is the failure this exists to prevent.
 *
 * Legacy packets are untouched: a packet that never received contract
 * instructions returns `not-applicable` and is judged exactly as before.
 */

import type { PacketTaskContract } from '@/lib/orchestrator/types';

export type CoverageFailureReason =
  | 'no-evidence-recorded'
  | 'requirement-not-evidenced'
  | 'cited-path-not-in-change'
  | 'contract-version-mismatch'
  | 'evidence-head-mismatch';

export interface RequirementEvidence {
  /** Must match a requirement id in the sealed contract. */
  requirementId: string;
  /** Repo-relative path the reviewer cites as carrying the implementation. */
  productionPath: string;
  /** Optional line/symbol anchor within that path. */
  anchor?: string;
  /** What the reviewer ran or observed to prove the behavior. */
  verification?: string;
}

export interface ReviewCoverageEvidence {
  /** Contract version this evidence was produced against. */
  contractVersion: number;
  /** HEAD the evidence was gathered at. */
  headSha: string;
  entries: RequirementEvidence[];
}

export interface RequirementCoverageCheck {
  requirementId: string;
  covered: boolean;
  citedPath: string | null;
  failureReason: CoverageFailureReason | null;
}

export interface ContractCoverageResult {
  status: 'passed' | 'failed' | 'not-applicable';
  reason: string;
  contractVersion: number | null;
  reviewedHeadSha: string | null;
  checks: RequirementCoverageCheck[];
  /** Exact ids the selector's targeted repair should address. */
  missingRequirementIds: string[];
}

export interface ContractCoverageInput {
  contract: PacketTaskContract | null | undefined;
  /** Omitted/false for packets dispatched before contract-first was enabled. */
  contractRequired: boolean | null | undefined;
  evidence: ReviewCoverageEvidence | null | undefined;
  /** HEAD the durable approval authorizes. */
  reviewedHeadSha: string | null | undefined;
  /** Repo-relative paths the packet's change actually touched. */
  changedPaths: readonly string[];
}

function normalizePath(value: string): string {
  return value.trim().replace(/^\.\//, '').replace(/^\/+/, '');
}

/** A cited path counts only if the change actually touched that file. */
function pathWasChanged(citedPath: string, changedPaths: readonly string[]): boolean {
  const cited = normalizePath(citedPath);
  if (cited.length === 0) return false;
  return changedPaths.some((changed) => {
    const normalized = normalizePath(changed);
    return normalized === cited
      || normalized.endsWith(`/${cited}`)
      || cited.endsWith(`/${normalized}`);
  });
}

function failAll(
  contract: PacketTaskContract,
  reason: CoverageFailureReason,
  message: string,
  reviewedHeadSha: string | null,
): ContractCoverageResult {
  const checks = contract.requirements.map((requirement) => ({
    requirementId: requirement.id,
    covered: false,
    citedPath: null,
    failureReason: reason,
  }));
  return {
    status: 'failed',
    reason: message,
    contractVersion: contract.version,
    reviewedHeadSha,
    checks,
    missingRequirementIds: checks.map((check) => check.requirementId),
  };
}

export function evaluateContractCoverage(input: ContractCoverageInput): ContractCoverageResult {
  const reviewedHeadSha = input.reviewedHeadSha ?? null;

  // Legacy packets never received contract instructions. Judging them against a
  // contract they were never given would retroactively block in-flight work.
  if (input.contractRequired !== true) {
    return {
      status: 'not-applicable',
      reason: 'Packet predates the contract-first pipeline; coverage is not required.',
      contractVersion: input.contract?.version ?? null,
      reviewedHeadSha,
      checks: [],
      missingRequirementIds: [],
    };
  }

  const contract = input.contract;
  if (!contract || contract.requirements.length === 0) {
    return {
      status: 'failed',
      reason: 'Contract coverage is required but the packet carries no sealed contract.',
      contractVersion: contract?.version ?? null,
      reviewedHeadSha,
      checks: [],
      missingRequirementIds: [],
    };
  }

  const evidence = input.evidence;
  if (!evidence || evidence.entries.length === 0) {
    return failAll(
      contract,
      'no-evidence-recorded',
      'The review recorded no per-requirement coverage evidence.',
      reviewedHeadSha,
    );
  }
  if (evidence.contractVersion !== contract.version) {
    return failAll(
      contract,
      'contract-version-mismatch',
      `Coverage evidence targets contract version ${evidence.contractVersion}, but the sealed contract is version ${contract.version}.`,
      reviewedHeadSha,
    );
  }
  if (!reviewedHeadSha || evidence.headSha !== reviewedHeadSha) {
    return failAll(
      contract,
      'evidence-head-mismatch',
      'Coverage evidence was gathered at a different commit than the review authorizes.',
      reviewedHeadSha,
    );
  }

  const byRequirement = new Map<string, RequirementEvidence>();
  for (const entry of evidence.entries) {
    if (typeof entry?.requirementId === 'string' && entry.requirementId.length > 0) {
      byRequirement.set(entry.requirementId, entry);
    }
  }

  const checks: RequirementCoverageCheck[] = contract.requirements.map((requirement) => {
    const entry = byRequirement.get(requirement.id);
    if (!entry) {
      return {
        requirementId: requirement.id,
        covered: false,
        citedPath: null,
        failureReason: 'requirement-not-evidenced' as const,
      };
    }
    const citedPath = typeof entry.productionPath === 'string' ? entry.productionPath : '';
    if (!pathWasChanged(citedPath, input.changedPaths)) {
      return {
        requirementId: requirement.id,
        covered: false,
        citedPath: citedPath || null,
        failureReason: 'cited-path-not-in-change' as const,
      };
    }
    return {
      requirementId: requirement.id,
      covered: true,
      citedPath,
      failureReason: null,
    };
  });

  const missingRequirementIds = checks.filter((check) => !check.covered).map((check) => check.requirementId);
  const passed = missingRequirementIds.length === 0;

  return {
    status: passed ? 'passed' : 'failed',
    reason: passed
      ? `All ${checks.length} sealed requirements carry production-path evidence at the reviewed HEAD.`
      : `${missingRequirementIds.length} of ${checks.length} sealed requirements lack production-path evidence: ${missingRequirementIds.join(', ')}.`,
    contractVersion: contract.version,
    reviewedHeadSha,
    checks,
    missingRequirementIds,
  };
}

/** Narrow reader for approval args, which are untyped at the storage boundary. */
export function readCoverageEvidence(args: unknown): ReviewCoverageEvidence | null {
  if (!args || typeof args !== 'object') return null;
  const raw = (args as { contractCoverageEvidence?: unknown }).contractCoverageEvidence;
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<ReviewCoverageEvidence>;
  if (typeof candidate.contractVersion !== 'number') return null;
  if (typeof candidate.headSha !== 'string') return null;
  if (!Array.isArray(candidate.entries)) return null;
  const entries = candidate.entries.filter((entry): entry is RequirementEvidence => (
    !!entry
    && typeof entry === 'object'
    && typeof (entry as RequirementEvidence).requirementId === 'string'
    && typeof (entry as RequirementEvidence).productionPath === 'string'
  ));
  return { contractVersion: candidate.contractVersion, headSha: candidate.headSha, entries };
}
