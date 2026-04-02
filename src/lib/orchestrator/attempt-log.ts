import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PacketSelfReview } from '@/lib/orchestrator/types';
import { truncateText } from '@/lib/util/text';

const ATTEMPT_LEARNINGS_RELATIVE_PATH = path.join('.o8', 'attempt-learnings.md');
const ATTEMPT_LEARNING_JSON_BLOCK_PATTERN = /```json\s*([\s\S]*?)\s*```/g;
const MAX_ATTEMPT_LEARNINGS = 3;
const MAX_TYPECHECK_OUTPUT_CHARS = 4_000;
const MAX_SUMMARY_CHARS = 500;
const MAX_FILES_CHANGED = 12;
const MAX_ERROR_LINES = 3;
const MAX_ERROR_LINE_CHARS = 240;
const FILE_REFERENCE_PATTERN = /([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|json|css|scss|md))(?:\(\d+,\d+\)|:\d+(?::\d+)?)?/g;

export interface AttemptLearning {
  attempt: number;
  timestamp: string;
  typecheckOutput?: string;
  selfReviewSummary?: string;
  filesChanged: string[];
  summary: string;
}

export type AttemptLearningDraft = Omit<AttemptLearning, 'attempt' | 'timestamp'>;

interface StoredAttemptLearning extends AttemptLearning {
  packetId?: string;
}

function getAttemptLearningsPath(worktreePath: string) {
  return path.join(worktreePath, ATTEMPT_LEARNINGS_RELATIVE_PATH);
}

function normalizeStringList(value: unknown, maxItems = MAX_FILES_CHANGED): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const items: string[] = [];
  for (const entry of value) {
    const normalized = typeof entry === 'string' ? entry.trim() : '';
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    items.push(normalized);
    if (items.length >= maxItems) {
      break;
    }
  }
  return items;
}

function normalizeAttemptLearning(value: unknown): StoredAttemptLearning | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const learning = value as Partial<StoredAttemptLearning>;
  const attempt = typeof learning.attempt === 'number' && Number.isFinite(learning.attempt) && learning.attempt >= 0
    ? Math.floor(learning.attempt)
    : null;
  const timestamp = typeof learning.timestamp === 'string' && learning.timestamp.trim()
    ? learning.timestamp
    : '';
  const summary = truncateText(
    typeof learning.summary === 'string' ? learning.summary : '',
    MAX_SUMMARY_CHARS,
    { normalizeWhitespace: true },
  );

  if (attempt === null || !timestamp || !summary) {
    return null;
  }

  const typecheckOutput = truncateText(learning.typecheckOutput, MAX_TYPECHECK_OUTPUT_CHARS);
  const selfReviewSummary = truncateText(learning.selfReviewSummary, MAX_SUMMARY_CHARS, {
    normalizeWhitespace: true,
  });

  return {
    packetId: typeof learning.packetId === 'string' && learning.packetId.trim() ? learning.packetId.trim() : undefined,
    attempt,
    timestamp,
    typecheckOutput: typecheckOutput || undefined,
    selfReviewSummary: selfReviewSummary || undefined,
    filesChanged: normalizeStringList(learning.filesChanged),
    summary,
  };
}

function serializeAttemptLearning(learning: StoredAttemptLearning) {
  return JSON.stringify({
    packetId: learning.packetId,
    attempt: learning.attempt,
    timestamp: learning.timestamp,
    typecheckOutput: learning.typecheckOutput,
    selfReviewSummary: learning.selfReviewSummary,
    filesChanged: learning.filesChanged,
    summary: learning.summary,
  }, null, 2);
}

function renderAttemptLearnings(entries: StoredAttemptLearning[]) {
  const lines = [
    '# Attempt Learnings',
    '',
    'Latest bounded learnings captured from failed retry attempts.',
  ];

  for (const learning of entries) {
    lines.push(
      '',
      `## Packet ${learning.packetId ?? 'unknown'} attempt ${learning.attempt}`,
      '',
      '```json',
      serializeAttemptLearning(learning),
      '```',
    );
  }

  return `${lines.join('\n')}\n`;
}

async function readStoredAttemptLearnings(worktreePath: string): Promise<StoredAttemptLearning[]> {
  const normalizedWorktreePath = worktreePath.trim();
  if (!normalizedWorktreePath) {
    return [];
  }

  const raw = await readFile(getAttemptLearningsPath(normalizedWorktreePath), 'utf8').catch(() => '');
  if (!raw.trim()) {
    return [];
  }

  const entries: StoredAttemptLearning[] = [];
  for (const match of raw.matchAll(ATTEMPT_LEARNING_JSON_BLOCK_PATTERN)) {
    const jsonBlock = match[1]?.trim();
    if (!jsonBlock) {
      continue;
    }

    try {
      const parsed = JSON.parse(jsonBlock) as unknown;
      const normalized = normalizeAttemptLearning(parsed);
      if (normalized) {
        entries.push(normalized);
      }
    } catch {
      // Ignore malformed entries so one bad block does not poison the file.
    }
  }

  return entries.slice(-MAX_ATTEMPT_LEARNINGS);
}

function extractTypecheckErrorLines(typecheckOutput?: string): string[] {
  if (!typecheckOutput?.trim()) {
    return [];
  }

  const seen = new Set<string>();
  const lines = typecheckOutput
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && /error\b/i.test(line));

  return lines.reduce<string[]>((current, line) => {
    if (current.length >= MAX_ERROR_LINES) {
      return current;
    }

    const normalized = truncateText(line, MAX_ERROR_LINE_CHARS, { normalizeWhitespace: true });
    if (!normalized || seen.has(normalized)) {
      return current;
    }

    seen.add(normalized);
    current.push(normalized);
    return current;
  }, []);
}

function extractReferencedFiles(input: string): string[] {
  const seen = new Set<string>();
  const matches = input.matchAll(FILE_REFERENCE_PATTERN);
  const files: string[] = [];

  for (const match of matches) {
    const candidate = match[1]?.trim();
    if (!candidate || seen.has(candidate)) {
      continue;
    }

    seen.add(candidate);
    files.push(candidate);
    if (files.length >= MAX_FILES_CHANGED) {
      break;
    }
  }

  return files;
}

function buildSelfReviewSummary(selfReview?: PacketSelfReview): string | undefined {
  if (!selfReview) {
    return undefined;
  }

  const issues = Array.isArray(selfReview.issuesFound) && selfReview.issuesFound.length > 0
    ? `Issues: ${selfReview.issuesFound.map((issue) => issue.trim()).filter(Boolean).join('; ')}`
    : '';
  const summary = truncateText(
    [selfReview.summary, issues].filter(Boolean).join(' | '),
    MAX_SUMMARY_CHARS,
    { normalizeWhitespace: true },
  );

  return summary || undefined;
}

export function buildAttemptLearningFromFailure(
  typecheckOutput?: string,
  selfReview?: PacketSelfReview,
): AttemptLearningDraft {
  const normalizedTypecheckOutput = truncateText(typecheckOutput, MAX_TYPECHECK_OUTPUT_CHARS);
  const selfReviewSummary = buildSelfReviewSummary(selfReview);
  const keyErrors = extractTypecheckErrorLines(normalizedTypecheckOutput);
  const filesChanged = extractReferencedFiles([
    normalizedTypecheckOutput,
    selfReviewSummary,
    ...(selfReview?.issuesFound ?? []),
  ].filter(Boolean).join('\n'));
  const summary = truncateText(
    [
      selfReviewSummary ? `Self-review: ${selfReviewSummary}` : '',
      keyErrors.length > 0 ? `Key errors: ${keyErrors.join(' | ')}` : '',
    ].filter(Boolean).join(' | ') || 'Retry required after a failed attempt with limited diagnostics.',
    MAX_SUMMARY_CHARS,
    { normalizeWhitespace: true },
  );

  return {
    typecheckOutput: normalizedTypecheckOutput || undefined,
    selfReviewSummary,
    filesChanged,
    summary,
  };
}

export async function readAttemptLearnings(worktreePath: string): Promise<AttemptLearning[]> {
  const entries = await readStoredAttemptLearnings(worktreePath);
  return entries.map((entry) => ({
    attempt: entry.attempt,
    timestamp: entry.timestamp,
    typecheckOutput: entry.typecheckOutput,
    selfReviewSummary: entry.selfReviewSummary,
    filesChanged: entry.filesChanged,
    summary: entry.summary,
  }));
}

export async function persistAttemptLearnings(
  worktreePath: string,
  packetId: string,
  attempt: number,
  learning: AttemptLearningDraft,
): Promise<void> {
  const normalizedWorktreePath = worktreePath.trim();
  if (!normalizedWorktreePath) {
    return;
  }

  const nextEntry = normalizeAttemptLearning({
    packetId,
    attempt,
    timestamp: new Date().toISOString(),
    ...learning,
  });
  if (!nextEntry) {
    return;
  }

  const filePath = getAttemptLearningsPath(normalizedWorktreePath);
  const currentEntries = await readStoredAttemptLearnings(normalizedWorktreePath);
  const nextEntries = [...currentEntries, nextEntry].slice(-MAX_ATTEMPT_LEARNINGS);

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, renderAttemptLearnings(nextEntries), 'utf8');
}
