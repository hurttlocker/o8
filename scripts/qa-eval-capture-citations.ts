/**
 * Capture actual citations the retriever returns for each case in
 * tests/qa-eval/cases.json — dumps to /tmp/qa-eval-actuals.json so
 * scripts/qa-eval-rewrite-citations.ts can re-anchor expectedCitations.
 *
 * One-shot helper for #915 path-to-70 phase 1.5 (re-anchor citations).
 *
 * Usage:
 *   npx tsx scripts/qa-eval-capture-citations.ts
 */

import 'server-only';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { askCortex } from '@/lib/cortex/qa/ask';

interface ExpectedCitation {
  kind: string;
  rowId: string;
}

interface CaseFile {
  cases: Array<{
    id: string;
    category: string;
    repoPath: string;
    question: string;
    expectedAnswer: string | null;
    expectedCitations: ExpectedCitation[];
    knownGap?: string;
  }>;
}

interface ActualEntry {
  id: string;
  category: string;
  knownGap: boolean;
  question: string;
  expectedAnswer: string | null;
  expectedCitations: ExpectedCitation[];
  class: 'A' | 'B';
  retrievalMs: number;
  classifyMs: number;
  answer: string;
  actualCitations: Array<{ kind: string; rowId: string; table: string }>;
}

async function main() {
  const casesPath = path.resolve(process.cwd(), 'tests/qa-eval/cases.json');
  const raw = await fs.readFile(casesPath, 'utf-8');
  const file = JSON.parse(raw) as CaseFile;

  const out: ActualEntry[] = [];

  for (const c of file.cases) {
    process.stderr.write(`[capture] ${c.id} (${c.category}) ...\n`);
    try {
      const result = await askCortex(c.question, c.repoPath, { bypassCache: true });
      out.push({
        id: c.id,
        category: c.category,
        knownGap: Boolean(c.knownGap),
        question: c.question,
        expectedAnswer: c.expectedAnswer,
        expectedCitations: c.expectedCitations,
        class: result.class,
        retrievalMs: result.retrievalMs,
        classifyMs: result.classifyMs,
        answer: result.answer,
        actualCitations: result.citations.map((cit) => ({
          kind: cit.kind,
          rowId: cit.rowId,
          table: cit.table,
        })),
      });
      process.stderr.write(
        `  → class=${result.class} citations=${result.citations.length} answer.len=${result.answer.length}\n`,
      );
    } catch (err) {
      process.stderr.write(
        `  → ERROR: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      out.push({
        id: c.id,
        category: c.category,
        knownGap: Boolean(c.knownGap),
        question: c.question,
        expectedAnswer: c.expectedAnswer,
        expectedCitations: c.expectedCitations,
        class: 'B',
        retrievalMs: 0,
        classifyMs: 0,
        answer: `(error) ${err instanceof Error ? err.message : String(err)}`,
        actualCitations: [],
      });
    }
  }

  const dest = '/tmp/qa-eval-actuals.json';
  await fs.writeFile(dest, JSON.stringify(out, null, 2), 'utf-8');
  process.stderr.write(`[capture] wrote ${out.length} entries to ${dest}\n`);
}

main().catch((err) => {
  console.error('[capture] fatal:', err);
  process.exit(1);
});
