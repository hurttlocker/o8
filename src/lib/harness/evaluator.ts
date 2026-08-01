import 'server-only';

import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { getActiveReviewerBackend } from '@/lib/lane/orchestrator-backends/registry';
import { classifyReviewRisk } from '@/lib/lane/review-risk';
import { EVALUATOR_DIFF_BYTE_LIMIT } from './capabilities';
import type {
  HarnessEvaluationFinding,
  HarnessEvaluationResult,
  HarnessEvaluationVerdict,
} from './types';

function changedFiles(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split('\n')) {
    const match = line.match(/^\+\+\+ b\/(.+)$/);
    if (match && match[1] !== '/dev/null') files.add(match[1]);
  }
  return [...files];
}

function addedLines(diff: string): string[] {
  return diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'));
}

function cleanFinding(value: unknown): HarnessEvaluationFinding | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const severity = row.severity;
  const title = typeof row.title === 'string' ? row.title.trim() : '';
  const detail = typeof row.detail === 'string' ? row.detail.trim() : '';
  if (!['critical', 'high', 'medium', 'low'].includes(String(severity)) || !title || !detail) return null;
  return {
    severity: severity as HarnessEvaluationFinding['severity'],
    file: typeof row.file === 'string' && row.file.trim() ? row.file.trim().slice(0, 1_000) : null,
    line: Number.isInteger(row.line) && Number(row.line) > 0 ? Number(row.line) : null,
    title: title.slice(0, 300),
    detail: detail.slice(0, 4_000),
  };
}

function extractJson(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function parseEvaluationResponse(input: {
  raw: string;
  risk: 'standard' | 'high';
  riskReasons: string[];
  reviewerBackend: string | null;
}): HarnessEvaluationResult {
  const parsed = extractJson(input.raw);
  const verdict = parsed?.verdict;
  const validVerdict = verdict === 'approve' || verdict === 'request_changes' || verdict === 'inconclusive'
    ? verdict as HarnessEvaluationVerdict
    : 'inconclusive';
  const findings = Array.isArray(parsed?.findings)
    ? parsed.findings.map(cleanFinding).filter((finding): finding is HarnessEvaluationFinding => finding !== null).slice(0, 50)
    : [];
  const summary = typeof parsed?.summary === 'string' && parsed.summary.trim()
    ? parsed.summary.trim().slice(0, 5_000)
    : parsed
      ? 'The reviewer returned no summary.'
      : 'The reviewer response was not valid structured JSON.';
  return {
    schema: 'o8/evaluate-diff/v1',
    verdict: validVerdict,
    summary,
    findings,
    risk: input.risk,
    riskReasons: input.riskReasons,
    reviewerBackend: input.reviewerBackend,
    reviewedAt: Date.now(),
  };
}

function buildPrompt(input: {
  task: string;
  diff: string;
  acceptanceCriteria: string[];
  risk: 'standard' | 'high';
  riskReasons: string[];
}): string {
  return [
    'You are o8_evaluate_diff, an independent skeptical evaluator.',
    'You did not see the generator transcript, plan, self-review, or claimed test results. Review only the task, acceptance criteria, and patch below.',
    'Do not call tools, modify files, or infer that omitted code is correct. Report only findings caused by this patch and cite the patch path and new-file line when possible.',
    input.risk === 'high'
      ? `This is a high-risk patch. Try to disprove its scope partition and state-transition safety. Risk signals: ${input.riskReasons.join('; ')}`
      : 'Check correctness, security, persistence, error handling, and whether the patch can be reached from its real entry point.',
    '',
    'Return one JSON object and no prose:',
    '{"verdict":"approve|request_changes|inconclusive","summary":"...","findings":[{"severity":"critical|high|medium|low","file":"path or null","line":123,"title":"...","detail":"..."}]}',
    '',
    'Task:',
    input.task,
    '',
    'Acceptance criteria:',
    ...(input.acceptanceCriteria.length ? input.acceptanceCriteria.map((criterion) => `- ${criterion}`) : ['- No explicit criteria supplied.']),
    '',
    'Unified diff:',
    input.diff,
  ].join('\n');
}

export async function evaluateDiff(input: {
  repoPath: string;
  task: string;
  diff: string;
  acceptanceCriteria?: string[];
}): Promise<HarnessEvaluationResult> {
  const task = input.task.trim();
  if (!task) throw new Error('task is required');
  if (task.length > 50_000) throw new Error('task exceeds 50000 characters');
  if (!input.diff.trim()) throw new Error('diff is required');
  const diffBytes = Buffer.byteLength(input.diff, 'utf8');
  if (diffBytes > EVALUATOR_DIFF_BYTE_LIMIT) {
    throw new Error(`diff exceeds ${EVALUATOR_DIFF_BYTE_LIMIT} bytes`);
  }
  const criteria = (input.acceptanceCriteria ?? [])
    .map((criterion) => criterion.trim())
    .filter(Boolean)
    .slice(0, 100);
  const risk = classifyReviewRisk(changedFiles(input.diff), addedLines(input.diff));
  const backend = getActiveReviewerBackend();
  const threadId = `harness-evaluate-${randomUUID()}`;
  const session = backend.ensureSession(input.repoPath, undefined, threadId);
  if (session.status === 'busy' || session.status === 'dead') {
    return parseEvaluationResponse({
      raw: JSON.stringify({
        verdict: 'inconclusive',
        summary: `${backend.label} reviewer session is ${session.status}.`,
        findings: [],
      }),
      risk: risk.tier,
      riskReasons: risk.reasons,
      reviewerBackend: backend.id,
    });
  }

  let text = '';
  const errors: string[] = [];
  try {
    await backend.sendTurn(
      input.repoPath,
      buildPrompt({
        task,
        diff: input.diff,
        acceptanceCriteria: criteria,
        risk: risk.tier,
        riskReasons: risk.reasons,
      }),
      (event) => {
        if (event.type === 'text') text += event.text;
        if (event.type === 'error') errors.push(event.error);
      },
      { threadId },
    );
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (errors.length > 0) {
    text = JSON.stringify({
      verdict: 'inconclusive',
      summary: `Reviewer failed: ${errors.join('; ').slice(0, 1_000)}`,
      findings: [],
    });
  }
  return parseEvaluationResponse({
    raw: text,
    risk: risk.tier,
    riskReasons: risk.reasons,
    reviewerBackend: backend.id,
  });
}
