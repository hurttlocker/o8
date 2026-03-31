import type { OrchestratorReviewFinding } from '@/lib/approvals/types';
import type { DiffFile } from '@/lib/worktree/diff-parser';

const MAX_REVIEW_ITEMS = 6;
const REVIEW_FINDING_HINT = /\b(bug|issue|problem|missing|missed|incorrect|wrong|regression|failed|failure|unsafe|risk|concern|needs?|must|should|lacks?|without|forgot|did not|does not|isn't|is not|can't|cannot)\b/i;
const REVIEW_PATTERN_HINT = /\b(always|never|prefer|avoid|use|follow|keep|only|do not|don't|watch for)\b/i;
const REVIEW_NOISE_HINT = /\b(recommend(?:ed)? approval|recommend(?:ed)? approve|approve|approved|looks correct|matches intent|ship it|ready to merge)\b/i;
const REVIEW_LABEL_PREFIX = /^(what changed|changes|concerns?|findings?|bugs?|issues?|lessons?|patterns?|watch(?:\s+for)?|recommendation):\s*/i;
const PATCH_HUNK_PATTERN = /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/g;
const REVIEW_FILE_HINT = /([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)(?::(\d+))?/;

function normalizeReviewItem(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(REVIEW_LABEL_PREFIX, '')
    .replace(/^[\-\*\d.)\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.;:,]+$/, '');
}

function pushUniqueValue(target: string[], seen: Set<string>, value?: string) {
  const normalized = normalizeReviewItem(value ?? '');
  if (!normalized) {
    return;
  }

  const key = normalized.toLowerCase();
  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  target.push(normalized);
}

function splitReviewItems(reviewSummary: string): string[] {
  return reviewSummary
    .replace(/\r\n/g, '\n')
    .split('\n')
    .flatMap((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return [];
      }

      const lineWithoutLabel = trimmed.replace(REVIEW_LABEL_PREFIX, '');
      return lineWithoutLabel
        .split(/(?<=[.!?;])\s+/)
        .flatMap((segment) => segment.split(/\s*[;]\s*/))
        .flatMap((segment) => {
          if (!/^(concerns?|findings?|bugs?|issues?|lessons?|watch(?:\s+for)?)/i.test(trimmed)) {
            return [segment];
          }

          return segment.split(/\s*,\s*/);
        });
    })
    .map((item) => normalizeReviewItem(item))
    .filter(Boolean)
    .slice(0, MAX_REVIEW_ITEMS * 3);
}

function inferFindingSeverity(description: string): OrchestratorReviewFinding['severity'] {
  if (/\b(import|style|pattern|convention|rule|lint|format)\b/i.test(description)) {
    return 'rule_violation';
  }
  if (REVIEW_FINDING_HINT.test(description)) {
    return 'bug';
  }
  return 'note';
}

function inferFindingResolution(description: string): OrchestratorReviewFinding['resolution'] {
  if (/\bfix(?:ed)?|resolved|addressed\b/i.test(description)) {
    return 'fixed';
  }
  if (/\baccepted|intentional|expected\b/i.test(description)) {
    return 'accepted';
  }
  return 'deferred';
}

function buildReviewFinding(description: string): OrchestratorReviewFinding {
  const normalized = normalizeReviewItem(description);
  const fileMatch = normalized.match(REVIEW_FILE_HINT);
  const line = fileMatch?.[2] ? Number.parseInt(fileMatch[2], 10) : undefined;

  return {
    file: fileMatch?.[1] ?? 'unknown',
    line: Number.isFinite(line) && line ? line : undefined,
    severity: inferFindingSeverity(normalized),
    description: normalized,
    resolution: inferFindingResolution(normalized),
  };
}

export function extractReviewFindings(reviewSummary: string): OrchestratorReviewFinding[] {
  const findings: OrchestratorReviewFinding[] = [];
  const seen = new Set<string>();

  for (const item of splitReviewItems(reviewSummary)) {
    if (!REVIEW_FINDING_HINT.test(item) || REVIEW_NOISE_HINT.test(item)) {
      continue;
    }

    const summary = normalizeReviewItem(item);
    if (!summary) {
      continue;
    }

    const key = summary.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    findings.push(buildReviewFinding(summary));

    if (findings.length >= MAX_REVIEW_ITEMS) {
      break;
    }
  }

  return findings;
}

export function extractReviewPatterns(
  reviewSummary: string,
  reviewFindings: OrchestratorReviewFinding[] = [],
): string[] {
  const patterns: string[] = [];
  const seen = new Set<string>();

  for (const item of splitReviewItems(reviewSummary)) {
    if (!REVIEW_PATTERN_HINT.test(item) || REVIEW_NOISE_HINT.test(item)) {
      continue;
    }

    pushUniqueValue(patterns, seen, item);
    if (patterns.length >= MAX_REVIEW_ITEMS) {
      return patterns;
    }
  }

  for (const finding of reviewFindings) {
    pushUniqueValue(patterns, seen, `Watch for ${finding.description}`);
    if (patterns.length >= MAX_REVIEW_ITEMS) {
      break;
    }
  }

  return patterns;
}

function summarizePatchRange(patch: string): { start: number; end: number } | null {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;

  for (const match of patch.matchAll(PATCH_HUNK_PATTERN)) {
    const nextStart = Number.parseInt(match[1] ?? '', 10);
    const nextCount = Number.parseInt(match[2] ?? '1', 10);
    if (!Number.isFinite(nextStart) || nextCount === 0) {
      continue;
    }

    start = Math.min(start, nextStart);
    end = Math.max(end, nextStart + Math.max(nextCount, 1) - 1);
  }

  return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null;
}

function formatConflictZone(path: string, range: { start: number; end: number } | null): string {
  if (!range) {
    return path;
  }

  return range.start === range.end
    ? `${path} (line ${range.start})`
    : `${path} (lines ${range.start}-${range.end})`;
}

export function buildConflictZonesFromDiffFiles(files: Array<Pick<DiffFile, 'path' | 'patch'>>): string[] {
  const zones: string[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const path = file.path.trim();
    if (!path || seen.has(path)) {
      continue;
    }

    seen.add(path);
    zones.push(formatConflictZone(path, summarizePatchRange(file.patch)));
  }

  return zones;
}
