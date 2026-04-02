import type { PacketSelfReview, PacketSelfReviewConfidence } from '@/lib/orchestrator/types';
import { truncateText } from '@/lib/util/text';

export const PACKET_SELF_REVIEW_TAG_START = '<self-review>';
export const PACKET_SELF_REVIEW_TAG_END = '</self-review>';

const SELF_REVIEW_SUMMARY_LIMIT = 320;
const SELF_REVIEW_ISSUE_LIMIT = 4;
const SELF_REVIEW_ISSUE_TEXT_LIMIT = 160;

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
    && (candidate.issuesFound === undefined || (Array.isArray(candidate.issuesFound) && candidate.issuesFound.every((entry) => typeof entry === 'string')));
}

export function normalizePacketSelfReview(review: PacketSelfReview): PacketSelfReview {
  return {
    passed: review.passed,
    confidence: review.confidence,
    summary: truncateText(review.summary.trim(), SELF_REVIEW_SUMMARY_LIMIT),
    issuesFound: normalizeIssues(review.issuesFound),
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
    '2. Evaluate the actual patch, not just filenames. If you find issues, fix them autonomously, rerun the diff, and repeat until the self-review passes.',
    `3. Only after the self-review passes, end your final response with a machine-readable block in this exact format: ${PACKET_SELF_REVIEW_TAG_START} {"passed":true,"confidence":"high|medium|low","summary":"one sentence","issuesFound":["issue you found and fixed"]} ${PACKET_SELF_REVIEW_TAG_END}`,
    '4. Use `confidence: "high"` only when the diff cleanly matches the task and your verification passed; use `medium` for moderate residual risk; use `low` when notable uncertainty remains.',
    '5. Do not report completion without the self-review block.',
  ];
}
