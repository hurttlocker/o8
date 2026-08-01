import type { ApprovalAuditEvent, OrchestratorReviewFinding } from '@/lib/approvals/types';
import { parseReviewFindings } from '@/lib/orchestrator/review-finding-input';
import type { Lane } from './types';

const CODEX_AUTO_REVIEW_MARKER = 'CODEX_AUTO_REVIEW:';
const RAW_TEXT_LIMIT = 2000;

export interface ParsedCodexAutoReviewVerdict {
  approved: boolean;
  findings: OrchestratorReviewFinding[];
  rawText: string;
  parseWarning?: string;
}

export interface RecordedCodexAutoReviewVerdict {
  event: ApprovalAuditEvent;
  verdict: ParsedCodexAutoReviewVerdict;
  reviewedHeadSha?: string;
}

function trimOptional(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function truncateRawText(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= RAW_TEXT_LIMIT) return normalized;
  return `${normalized.slice(0, RAW_TEXT_LIMIT - 3)}...`;
}

function fallbackFinding(description: string): OrchestratorReviewFinding {
  return {
    file: 'codex-auto-review',
    severity: 'rule_violation',
    description: truncateRawText(description) || 'Codex auto-review returned no verdict text.',
    resolution: 'deferred',
  };
}

function takeBalancedJsonObject(input: string): string | null {
  const start = input.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < input.length; index += 1) {
    const char = input[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return input.slice(start, index + 1);
    }
  }

  return null;
}

function extractJsonPayload(rawText: string): Record<string, unknown> | null {
  const markerIndex = rawText.lastIndexOf(CODEX_AUTO_REVIEW_MARKER);
  if (markerIndex >= 0) {
    const markedJson = takeBalancedJsonObject(rawText.slice(markerIndex + CODEX_AUTO_REVIEW_MARKER.length));
    if (markedJson) {
      try {
        return JSON.parse(markedJson) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }

  const fencedBlocks = Array.from(rawText.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)).reverse();
  for (const block of fencedBlocks) {
    const body = block[1]?.trim() ?? '';
    if (!/"?(approved|verdict|findings)"?\s*:/i.test(body)) continue;
    const json = takeBalancedJsonObject(body);
    if (!json) continue;
    try {
      return JSON.parse(json) as Record<string, unknown>;
    } catch {
      // Try the next fenced block.
    }
  }

  return null;
}

function readApproved(payload: Record<string, unknown>): boolean | null {
  if (typeof payload.approved === 'boolean') return payload.approved;
  const verdict = trimOptional(payload.verdict)?.toLowerCase().replace(/[\s-]+/g, '_');
  if (!verdict) return null;
  if (/^(approve|approved|pass|passed)$/.test(verdict)) return true;
  if (/^(reject|rejected|request_changes|changes_requested|fail|failed)$/.test(verdict)) return false;
  return null;
}

function parsePayloadFindings(payload: Record<string, unknown>): OrchestratorReviewFinding[] {
  const findings = Array.isArray(payload.findings) ? payload.findings : [];
  return parseReviewFindings(findings);
}

export function appendCodexAutoReviewVerdictInstructions(prompt: string): string {
  return [
    prompt,
    '',
    '## Codex auto-review fallback',
    '',
    'If submit_review is unavailable in this runtime, still complete the review and end with one final machine-readable line:',
    `${CODEX_AUTO_REVIEW_MARKER} {"approved":true,"findings":[]}`,
    'For requested changes, set approved to false and include findings with file, line when known, severity (bug|rule_violation|note), description, and status (fixed|accepted|deferred).',
    'Do not put any text after the CODEX_AUTO_REVIEW line.',
  ].join('\n');
}

export function parseCodexAutoReviewVerdict(rawText: string): ParsedCodexAutoReviewVerdict {
  const raw = truncateRawText(rawText);
  const payload = extractJsonPayload(rawText);
  if (!payload) {
    return {
      approved: false,
      findings: [fallbackFinding(`Codex auto-review verdict was not structured. Raw verdict: ${raw}`)],
      rawText: raw,
      parseWarning: 'missing CODEX_AUTO_REVIEW JSON payload',
    };
  }

  const approved = readApproved(payload);
  if (approved === null) {
    return {
      approved: false,
      findings: [fallbackFinding(`Codex auto-review JSON did not include a valid approved/verdict value. Raw verdict: ${raw}`)],
      rawText: raw,
      parseWarning: 'invalid approved/verdict value',
    };
  }

  try {
    const findings = parsePayloadFindings(payload);
    if (!approved && findings.length === 0) {
      return {
        approved: false,
        findings: [fallbackFinding(`Codex requested changes without structured findings. Raw verdict: ${raw}`)],
        rawText: raw,
        parseWarning: 'rejected verdict had no structured findings',
      };
    }
    return { approved, findings, rawText: raw };
  } catch (error) {
    return {
      approved: false,
      findings: [fallbackFinding(`Codex auto-review findings were invalid: ${error instanceof Error ? error.message : String(error)}. Raw verdict: ${raw}`)],
      rawText: raw,
      parseWarning: 'invalid structured findings',
    };
  }
}

async function captureReviewedHeadSha(lane: Lane): Promise<string | undefined> {
  const cwd = lane.worktreePath || lane.repoPath;
  if (!cwd) return undefined;
  try {
    const { normalizeHeadSha, readHeadSha } = await import('@/lib/lane/head-sha-lock');
    return normalizeHeadSha(await readHeadSha(cwd));
  } catch (error) {
    console.warn(`[auto-review] Failed to capture reviewed HEAD for Codex verdict on lane ${lane.id}:`, error);
    return undefined;
  }
}

export async function recordCodexAutoReviewVerdict(input: {
  lane: Lane;
  rawText: string;
  requiresSecondPass: boolean;
  reviewTurnId: string | null;
}): Promise<RecordedCodexAutoReviewVerdict | null> {
  if (!input.lane.packetId) {
    console.warn(`[auto-review] Codex verdict for lane ${input.lane.id} had no packet id; skipping approval record`);
    return null;
  }

  const verdict = parseCodexAutoReviewVerdict(input.rawText);
  const reviewedHeadSha = await captureReviewedHeadSha(input.lane);
  const { recordOrchestratorReview } = await import('@/lib/approvals/store');
  const event = recordOrchestratorReview(input.lane.packetId, {
    findings: verdict.findings,
    reviewer: 'codex',
    approved: verdict.approved,
    reviewedHeadSha,
    requiresSecondPass: verdict.approved && input.requiresSecondPass,
    rawText: verdict.parseWarning ? verdict.rawText : undefined,
    parseWarning: verdict.parseWarning,
    ...(input.reviewTurnId ? {
      reviewTurnId: input.reviewTurnId,
      reviewTurnOutcome: 'completed',
    } : {}),
  });

  return { event, verdict, reviewedHeadSha };
}
