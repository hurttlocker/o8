/**
 * Best-of-n comparison meta-agent (#517).
 *
 * When N parallel lanes in a comparison group complete, this module produces
 * structured side-by-side commentary so the operator can pick a winner (or
 * merge parts of several). Commentary is:
 *   - a short overall summary of how the candidates diverged
 *   - per-candidate strengths, concerns, and a verdict chip
 *   - optionally a recommended packetId the meta-agent would pick
 *
 * The meta-agent is delegated to a small Claude Haiku call via the direct
 * Anthropic API when ANTHROPIC_API_KEY is present. When the key is missing,
 * we fall back to a deterministic heuristic so the approval UI always has
 * something to render (never blank).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { OrchestratorPacket } from './types';

const execFileAsync = promisify(execFile);

/** Hard cap on diff size we ship to the meta-agent per candidate. Large
 * diffs get summarized via shortstat + head to keep the call cheap. */
const MAX_DIFF_CHARS_PER_CANDIDATE = 6_000;
const ANTHROPIC_META_MODEL = 'claude-haiku-4-5';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_TIMEOUT_MS = 45_000;

export type ComparisonVerdict = 'recommend' | 'neutral' | 'concern';

export interface ComparisonCandidateCommentary {
  packetId: string;
  modelLabel: string;
  verdict: ComparisonVerdict;
  strengths: string[];
  concerns: string[];
  oneLineSummary: string;
  changedFileCount: number;
  totalChanges: number;
}

export interface ComparisonCommentary {
  groupId: string;
  summary: string;
  recommendedPacketId: string | null;
  candidates: ComparisonCandidateCommentary[];
  source: 'meta-agent' | 'fallback-heuristic';
  generatedAt: string;
}

export interface ComparisonPacketDiff {
  packet: OrchestratorPacket;
  worktreePath: string | null;
  baseBranch: string;
  /** Abbreviated diff content (possibly truncated to MAX_DIFF_CHARS_PER_CANDIDATE). */
  diff: string;
  shortstat: string;
  changedFileCount: number;
  totalChanges: number;
}

/** Resolve a packet's worktree and current diff against the base branch.
 * Returns null when the packet has no lane/worktree yet. */
export async function collectPacketDiff(
  packet: OrchestratorPacket,
  baseBranchHint?: string | null,
): Promise<ComparisonPacketDiff | null> {
  const worktreePath = packet.lane?.worktreePath ?? packet.lane?.repoPath ?? null;
  if (!worktreePath) {
    return null;
  }

  const baseBranch = (baseBranchHint ?? '').trim() || 'main';

  let diff = '';
  let shortstat = '';
  try {
    const shortstatResult = await execFileAsync(
      'git',
      ['diff', '--shortstat', `${baseBranch}...HEAD`],
      { cwd: worktreePath, maxBuffer: 4 * 1024 * 1024 },
    );
    shortstat = shortstatResult.stdout.trim();
  } catch (error) {
    console.warn(
      `[comparison-meta] Failed to run git diff --shortstat in ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const diffResult = await execFileAsync(
      'git',
      ['diff', '--unified=1', `${baseBranch}...HEAD`],
      { cwd: worktreePath, maxBuffer: 8 * 1024 * 1024 },
    );
    diff = diffResult.stdout;
  } catch (error) {
    console.warn(
      `[comparison-meta] Failed to run git diff in ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (diff.length > MAX_DIFF_CHARS_PER_CANDIDATE) {
    diff = `${diff.slice(0, MAX_DIFF_CHARS_PER_CANDIDATE)}\n\n…diff truncated (${diff.length - MAX_DIFF_CHARS_PER_CANDIDATE} chars dropped)`;
  }

  const { changedFileCount, totalChanges } = parseShortstat(shortstat);

  return {
    packet,
    worktreePath,
    baseBranch,
    diff,
    shortstat,
    changedFileCount,
    totalChanges,
  };
}

function parseShortstat(line: string): { changedFileCount: number; totalChanges: number } {
  // Example: " 3 files changed, 42 insertions(+), 7 deletions(-)"
  const fileMatch = line.match(/(\d+)\s+files?\s+changed/);
  const insMatch = line.match(/(\d+)\s+insertions?/);
  const delMatch = line.match(/(\d+)\s+deletions?/);
  return {
    changedFileCount: fileMatch ? Number.parseInt(fileMatch[1], 10) : 0,
    totalChanges: (insMatch ? Number.parseInt(insMatch[1], 10) : 0) + (delMatch ? Number.parseInt(delMatch[1], 10) : 0),
  };
}

function modelLabelForPacket(packet: OrchestratorPacket): string {
  if (packet.assignedModel && packet.assignedModel.trim()) {
    return packet.assignedModel.trim();
  }
  return packet.runtime === 'claude-code' ? 'Claude Code' : 'Codex';
}

/**
 * Build a heuristic commentary when the meta-agent is unavailable.
 * Ranks candidates by (passed self-review > not failed > smaller diff) so the
 * operator still gets a reasonable "Pick" nudge.
 */
function buildFallbackCommentary(
  groupId: string,
  diffs: ComparisonPacketDiff[],
): ComparisonCommentary {
  const candidates = diffs.map<ComparisonCandidateCommentary>((entry) => {
    const status = entry.packet.status;
    const strengths: string[] = [];
    const concerns: string[] = [];

    if (status === 'awaiting_review' && entry.packet.review?.approved !== false) {
      strengths.push('Completed and passed self-review gate.');
    }
    if (entry.changedFileCount > 0 && entry.changedFileCount <= 4) {
      strengths.push(`Focused change: ${entry.changedFileCount} file${entry.changedFileCount === 1 ? '' : 's'}.`);
    }
    if (status === 'failed') {
      concerns.push('Lane failed before completion.');
    }
    if (entry.changedFileCount > 10) {
      concerns.push(`Wide change surface: ${entry.changedFileCount} files.`);
    }
    if (entry.totalChanges > 600) {
      concerns.push(`Large edit volume: ${entry.totalChanges} line changes.`);
    }

    let verdict: ComparisonVerdict = 'neutral';
    if (status === 'failed') verdict = 'concern';
    else if (strengths.length > concerns.length && status === 'awaiting_review') verdict = 'recommend';

    return {
      packetId: entry.packet.id,
      modelLabel: modelLabelForPacket(entry.packet),
      verdict,
      strengths,
      concerns,
      oneLineSummary: entry.shortstat || `${modelLabelForPacket(entry.packet)} candidate`,
      changedFileCount: entry.changedFileCount,
      totalChanges: entry.totalChanges,
    };
  });

  const recommendedPacketId =
    candidates.find((candidate) => candidate.verdict === 'recommend')?.packetId
    ?? candidates.find((candidate) => candidate.verdict !== 'concern')?.packetId
    ?? null;

  return {
    groupId,
    summary: diffs.length === 0
      ? 'Comparison group has no diffs to analyze yet.'
      : `Heuristic commentary across ${diffs.length} candidate${diffs.length === 1 ? '' : 's'}. Set ANTHROPIC_API_KEY to enable meta-agent rationale.`,
    recommendedPacketId,
    candidates,
    source: 'fallback-heuristic',
    generatedAt: new Date().toISOString(),
  };
}

interface MetaAgentPayload {
  summary?: string;
  recommendedPacketId?: string | null;
  candidates?: Array<{
    packetId?: string;
    verdict?: ComparisonVerdict;
    strengths?: string[];
    concerns?: string[];
    oneLineSummary?: string;
  }>;
}

function sanitizeStringArray(value: unknown, limit = 4): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function sanitizeVerdict(value: unknown): ComparisonVerdict {
  if (value === 'recommend' || value === 'neutral' || value === 'concern') return value;
  return 'neutral';
}

function mergeAgentPayloadIntoFallback(
  fallback: ComparisonCommentary,
  agentPayload: MetaAgentPayload,
): ComparisonCommentary {
  const byPacketId = new Map(fallback.candidates.map((candidate) => [candidate.packetId, candidate] as const));
  const enriched: ComparisonCandidateCommentary[] = fallback.candidates.map((candidate) => {
    const agentCandidate = agentPayload.candidates?.find((entry) => entry.packetId === candidate.packetId);
    if (!agentCandidate) return candidate;
    return {
      ...candidate,
      verdict: sanitizeVerdict(agentCandidate.verdict),
      strengths: sanitizeStringArray(agentCandidate.strengths),
      concerns: sanitizeStringArray(agentCandidate.concerns),
      oneLineSummary: typeof agentCandidate.oneLineSummary === 'string' && agentCandidate.oneLineSummary.trim()
        ? agentCandidate.oneLineSummary.trim().slice(0, 220)
        : candidate.oneLineSummary,
    };
  });

  const normalizedRecommended = typeof agentPayload.recommendedPacketId === 'string'
    && byPacketId.has(agentPayload.recommendedPacketId)
      ? agentPayload.recommendedPacketId
      : fallback.recommendedPacketId;

  const summary = typeof agentPayload.summary === 'string' && agentPayload.summary.trim()
    ? agentPayload.summary.trim().slice(0, 720)
    : fallback.summary;

  return {
    ...fallback,
    summary,
    recommendedPacketId: normalizedRecommended,
    candidates: enriched,
    source: 'meta-agent',
  };
}

function buildMetaPrompt(diffs: ComparisonPacketDiff[]): string {
  const packetBlocks = diffs.map((entry, index) => [
    `## Candidate ${index + 1}`,
    `packetId: ${entry.packet.id}`,
    `model: ${modelLabelForPacket(entry.packet)}`,
    `status: ${entry.packet.status}`,
    `shortstat: ${entry.shortstat || '(empty)'}`,
    '',
    '```diff',
    entry.diff || '(no diff)',
    '```',
  ].join('\n')).join('\n\n');

  return [
    'You are reviewing N parallel attempts at the same coding task, one per model.',
    'Produce a concise, structured comparison so a human operator can pick a winner.',
    '',
    'Rules:',
    '- Output STRICT JSON only, no prose outside the JSON.',
    '- Keep strengths/concerns terse (max 4 each, each ≤ 120 chars).',
    '- verdict must be one of: "recommend" | "neutral" | "concern".',
    '- recommendedPacketId must match one of the packetIds below (or null).',
    '- Base your judgement on code quality, scope discipline, and adherence to the task — not surface churn.',
    '',
    'Schema:',
    '{',
    '  "summary": "1-2 sentence overall comparison",',
    '  "recommendedPacketId": "pkt-abc" | null,',
    '  "candidates": [',
    '    {',
    '      "packetId": "pkt-abc",',
    '      "verdict": "recommend" | "neutral" | "concern",',
    '      "strengths": ["..."],',
    '      "concerns": ["..."],',
    '      "oneLineSummary": "what this candidate did, in one line"',
    '    }',
    '  ]',
    '}',
    '',
    packetBlocks,
  ].join('\n');
}

async function callAnthropicMetaAgent(diffs: ComparisonPacketDiff[]): Promise<MetaAgentPayload | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }

  const prompt = buildMetaPrompt(diffs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS);

  try {
    const response = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_META_MODEL,
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown');
      console.warn(`[comparison-meta] Anthropic call failed (${response.status}): ${text.slice(0, 200)}`);
      return null;
    }

    const payload = await response.json().catch(() => null) as {
      content?: Array<{ type?: string; text?: string }>;
    } | null;
    const textBlock = payload?.content?.find((block) => block?.type === 'text' && typeof block.text === 'string');
    const rawText = textBlock?.text?.trim();
    if (!rawText) {
      console.warn('[comparison-meta] Anthropic response had no text block.');
      return null;
    }

    // Strip common JSON-fence wrappers before parsing.
    const jsonText = rawText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    try {
      return JSON.parse(jsonText) as MetaAgentPayload;
    } catch (error) {
      console.warn(
        `[comparison-meta] Failed to parse meta-agent JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.warn('[comparison-meta] Anthropic call timed out.');
    } else {
      console.warn(
        `[comparison-meta] Anthropic call errored: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build a full ComparisonCommentary for a completed best-of-n group.
 * Never throws — always returns something renderable, falling back to the
 * heuristic when the meta-agent is unavailable or errors.
 */
export async function buildComparisonCommentary(
  groupId: string,
  diffs: ComparisonPacketDiff[],
): Promise<ComparisonCommentary> {
  const fallback = buildFallbackCommentary(groupId, diffs);
  if (diffs.length === 0) {
    return fallback;
  }

  const agentPayload = await callAnthropicMetaAgent(diffs);
  if (!agentPayload) {
    return fallback;
  }
  return mergeAgentPayloadIntoFallback(fallback, agentPayload);
}
