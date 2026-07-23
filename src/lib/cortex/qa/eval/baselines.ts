/**
 * Naive baselines for #938 — three-way memory-substrate comparison.
 *
 * Each function returns the same `TypedRow[]` shape that `retrieveAll() +
 * unionMerge()` produces. The composer (composeClassA / composeClassB) is
 * held constant across all three conditions; the only varied input is the
 * row set. This isolates the memory-substrate contribution from the
 * composer-LLM contribution.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { TypedRow } from '@/lib/cortex/qa/types';
import {
  buildStrongGrepTopRowsImpl,
  type StrongGrepOptions,
} from './strong-grep-baseline';
import { getDataDir } from '@/lib/data-dir-migration';

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has',
  'have', 'how', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this',
  'to', 'was', 'were', 'will', 'with', 'what', 'which', 'who', 'why',
  'when', 'where', 'do', 'does', 'did', 'i', 'you', 'we', 'they', 'them',
  'their', 'our', 'us', 'me', 'should', 'would', 'could', 'can', 'may',
  'might', 'must', 'shall', 'about', 'into', 'over', 'than', 'then',
]);

function tokenize(question: string): string[] {
  return question
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Grep baseline — what a hostile reader reaches for first to dismiss the
 * memory substrate as "just markdown + grep." Scans CLAUDE.md (project +
 * global) and the repo registry, picks the top-K lines with the most
 * keyword hits, returns 3-line context windows for the composer to chew on.
 */
export async function buildGrepTopRows(
  question: string,
  repoPath: string | undefined,
  topK = 15,
): Promise<TypedRow[]> {
  const keywords = tokenize(question);
  if (keywords.length === 0) return [];

  const sources: string[] = [];
  if (repoPath) {
    sources.push(path.join(repoPath, 'CLAUDE.md'));
  }
  sources.push(path.join(os.homedir(), 'CLAUDE.md'));
  sources.push(path.join(getDataDir(), 'repos.json'));
  sources.push(path.join(os.homedir(), '.cortex-ide', 'repos.json'));

  const allMatches: Array<{ source: string; line: number; text: string; score: number }> = [];

  for (const src of sources) {
    let content: string;
    try {
      content = await fs.readFile(src, 'utf-8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const lower = line.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (lower.includes(kw)) score += 1;
      }
      if (score === 0) continue;
      const ctxStart = Math.max(0, i - 1);
      const ctxEnd = Math.min(lines.length, i + 2);
      const text = lines.slice(ctxStart, ctxEnd).join('\n');
      allMatches.push({ source: src, line: i + 1, text, score });
    }
  }

  allMatches.sort((a, b) => b.score - a.score);

  return allMatches.slice(0, topK).map((m) => ({
    citation: {
      kind: 'doc' as const,
      rowId: `grep:${path.basename(m.source)}:L${m.line}`,
      table: 'doc',
      sourcePath: m.source,
      line: m.line,
      excerpt: m.text,
    },
    fields: {
      grep_source: m.source,
      grep_line: m.line,
      grep_score: m.score,
      content: m.text,
    },
    score: m.score,
  }));
}

export async function buildStrongGrepTopRows(
  question: string,
  repoPath: string | undefined,
  opts: StrongGrepOptions = {},
): Promise<TypedRow[]> {
  return buildStrongGrepTopRowsImpl(question, repoPath, {
    ...opts,
    tokenize,
    fallback: buildGrepTopRows,
  });
}

/**
 * Blind baseline — composer sees only the question, no rows.
 * The floor: how much can the LLM answer from training data alone?
 */
export function buildBlindTopRows(): TypedRow[] {
  return [];
}
