import type {
  PacketSelfReview,
  PacketSelfReviewConfidence,
  PacketSelfReviewDecision,
} from '@/lib/orchestrator/types';
import { truncateText } from '@/lib/util/text';

export const PACKET_SELF_REVIEW_TAG_START = '<self-review>';
export const PACKET_SELF_REVIEW_TAG_END = '</self-review>';

const SELF_REVIEW_SUMMARY_LIMIT = 320;
const SELF_REVIEW_ISSUE_LIMIT = 4;
const SELF_REVIEW_ISSUE_TEXT_LIMIT = 160;
const SELF_REVIEW_DETAIL_LIMIT = 320;
const SELF_REVIEW_EVIDENCE_LIMIT = 6;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSelfReviewPattern(flags = ''): RegExp {
  return new RegExp(
    `${escapeRegExp(PACKET_SELF_REVIEW_TAG_START)}\\s*([\\s\\S]*?)\\s*${escapeRegExp(PACKET_SELF_REVIEW_TAG_END)}`,
    flags,
  );
}

function isConfidence(value: unknown): value is PacketSelfReviewConfidence {
  return value === 'high' || value === 'medium' || value === 'low';
}

function isDecision(value: unknown): value is PacketSelfReviewDecision {
  return value === 'implementation_ready' || value === 'partial' || value === 'blocked';
}

function decisionMatchesPassed(
  decision: PacketSelfReviewDecision | undefined,
  passed: boolean,
): boolean {
  if (!decision) return true;
  return decision === 'implementation_ready' ? passed : !passed;
}

function normalizeDetail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = truncateText(value.trim(), SELF_REVIEW_DETAIL_LIMIT);
  return normalized || undefined;
}

function normalizeEvidence(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const evidence = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => truncateText(entry.trim(), SELF_REVIEW_ISSUE_TEXT_LIMIT))
    .filter(Boolean)
    .slice(0, SELF_REVIEW_EVIDENCE_LIMIT);
  return evidence.length > 0 ? evidence : undefined;
}

function normalizeIssues(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const issues = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => truncateText(entry.trim(), SELF_REVIEW_ISSUE_TEXT_LIMIT))
    .filter(Boolean)
    .slice(0, SELF_REVIEW_ISSUE_LIMIT);

  return issues.length > 0 ? issues : undefined;
}

export function isPacketSelfReview(value: unknown): value is PacketSelfReview {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.passed === 'boolean'
    && isConfidence(candidate.confidence)
    && typeof candidate.summary === 'string'
    && (candidate.issuesFound === undefined || (Array.isArray(candidate.issuesFound) && candidate.issuesFound.every((entry) => typeof entry === 'string')))
    && (candidate.outcome === undefined || typeof candidate.outcome === 'string')
    && (candidate.evidence === undefined || (Array.isArray(candidate.evidence) && candidate.evidence.every((entry) => typeof entry === 'string')))
    && (candidate.residual === undefined || typeof candidate.residual === 'string')
    && (candidate.decision === undefined || isDecision(candidate.decision))
    && decisionMatchesPassed(candidate.decision as PacketSelfReviewDecision | undefined, candidate.passed)
    && (candidate.recurrenceProtection === undefined || typeof candidate.recurrenceProtection === 'string');
}

export function normalizePacketSelfReview(review: PacketSelfReview): PacketSelfReview {
  return {
    passed: review.passed,
    confidence: review.confidence,
    summary: truncateText(review.summary.trim(), SELF_REVIEW_SUMMARY_LIMIT),
    issuesFound: normalizeIssues(review.issuesFound),
    outcome: normalizeDetail(review.outcome),
    evidence: normalizeEvidence(review.evidence),
    residual: normalizeDetail(review.residual),
    decision: review.decision,
    recurrenceProtection: normalizeDetail(review.recurrenceProtection),
  };
}

export function buildMissingPacketSelfReview(
  summary = 'Agent completion did not include the required self-review block.',
): PacketSelfReview {
  return {
    passed: false,
    confidence: 'low',
    summary: truncateText(summary.trim(), SELF_REVIEW_SUMMARY_LIMIT),
  };
}

export function parsePacketSelfReview(text: string): PacketSelfReview | null {
  const match = text.match(buildSelfReviewPattern());
  if (!match?.[1]) {
    return null;
  }

  try {
    const parsed = JSON.parse(match[1]) as unknown;
    if (!isPacketSelfReview(parsed)) {
      return null;
    }
    return normalizePacketSelfReview(parsed);
  } catch {
    return null;
  }
}

export function stripPacketSelfReview(text: string): string {
  return text.replace(buildSelfReviewPattern('g'), '').trim();
}

export function buildPacketSelfReviewInstructions(baseBranch = 'main'): string[] {
  return [
    'Self-review gate before completion:',
    `1. Before reporting completion, review your own diff against the original task by running \`git diff ${baseBranch}...HEAD\`.`,
    '2. Evaluate the actual patch against the original desired outcome, not just filenames. Distinguish the implementation evidence you observed from the user-facing outcome that still requires independent review. If you find issues that would BREAK the task (typecheck failure, runtime crash, scope creep, security risk), fix them and rerun the diff. Cap fix attempts at TWO per issue — if a fix attempt does not resolve the finding, accept the current state, record the residual, set `decision: "partial"`, and commit. Do NOT loop indefinitely.',
    '3. Lint warnings (especially `react-hooks/exhaustive-deps` and other style-only rules) are ADVISORY, not blocking. Do not gate self-review on a clean lint pass — note any warnings in the issuesFound array and finalize the packet.',
    `4. End your final response with a machine-readable block in this exact format: ${PACKET_SELF_REVIEW_TAG_START} {"passed":true,"confidence":"high|medium|low","summary":"one sentence","issuesFound":["issue you found and fixed"],"outcome":"observable result the implementation supports","evidence":["command, artifact, or real-path observation"],"residual":"remaining uncertainty or none","decision":"implementation_ready|partial|blocked","recurrenceProtection":"test, invariant, validation, automation, durable learning, or none"} ${PACKET_SELF_REVIEW_TAG_END}`,
    '5. Use `decision: "implementation_ready"` and `passed: true` only when the scoped implementation and its verification are ready for independent review. This does not declare the user-facing outcome closed. Use `decision: "partial"` or `"blocked"` with `passed: false` whenever notable work or authority remains.',
    '6. Use `confidence: "high"` only when the diff cleanly matches the task and your verification passed; use `medium` for moderate residual risk OR an unfixable lint warning OR an exhausted retry; use `low` when notable uncertainty remains.',
    '7. Do not report completion without the self-review block.',
  ];
}
