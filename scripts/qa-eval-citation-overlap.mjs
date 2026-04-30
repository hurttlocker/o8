#!/usr/bin/env node
/**
 * Compute citation overlap (set intersection / union, Jaccard) between the
 * expectedCitations on each case and the actualCitations the retriever
 * returned. Compares two cases.json snapshots so we can quantify how much
 * the phase 1.5 re-anchor moved citation correctness.
 *
 * Usage:
 *   node scripts/qa-eval-citation-overlap.mjs <before.json> <after.json> <actuals.json>
 *
 * Where:
 *   before.json  — original cases.json (pre-rewrite)
 *   after.json   — current cases.json (post-rewrite)
 *   actuals.json — output of qa-eval-capture-citations.ts
 */

import { promises as fs } from 'node:fs';

const [, , beforeArg, afterArg, actualsArg] = process.argv;
if (!beforeArg || !afterArg || !actualsArg) {
  console.error('usage: node scripts/qa-eval-citation-overlap.mjs <before.json> <after.json> <actuals.json>');
  process.exit(1);
}

const before = JSON.parse(await fs.readFile(beforeArg, 'utf-8'));
const after = JSON.parse(await fs.readFile(afterArg, 'utf-8'));
const actuals = JSON.parse(await fs.readFile(actualsArg, 'utf-8'));

const actualsById = new Map(actuals.map((a) => [a.id, a]));

function pairKey(c) {
  return `${c.kind}::${c.rowId}`;
}
function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
}

const categories = new Set(before.cases.map((c) => c.category));
const perCat = {};
for (const cat of categories) {
  perCat[cat] = { beforeSum: 0, afterSum: 0, count: 0 };
}

for (const b of before.cases) {
  const a = after.cases.find((x) => x.id === b.id);
  const act = actualsById.get(b.id);
  if (!a || !act) continue;
  if (b.expectedCitations.length === 0 && a.expectedCitations.length === 0) {
    // gap-style cases — both 0, perfect overlap with empty actuals.
    perCat[b.category].count += 1;
    perCat[b.category].beforeSum += jaccard(
      new Set(b.expectedCitations.map(pairKey)),
      new Set(act.actualCitations.map(pairKey)),
    );
    perCat[b.category].afterSum += jaccard(
      new Set(a.expectedCitations.map(pairKey)),
      new Set(act.actualCitations.map(pairKey)),
    );
    continue;
  }
  perCat[b.category].count += 1;
  perCat[b.category].beforeSum += jaccard(
    new Set(b.expectedCitations.map(pairKey)),
    new Set(act.actualCitations.map(pairKey)),
  );
  perCat[b.category].afterSum += jaccard(
    new Set(a.expectedCitations.map(pairKey)),
    new Set(act.actualCitations.map(pairKey)),
  );
}

console.log('| Category   | Before Jaccard | After Jaccard | Δ      |');
console.log('|------------|----------------|---------------|--------|');
for (const cat of [...categories].sort()) {
  const p = perCat[cat];
  const before = p.count ? p.beforeSum / p.count : 0;
  const after = p.count ? p.afterSum / p.count : 0;
  console.log(
    `| ${cat.padEnd(10)} | ${(before * 100).toFixed(1).padStart(13)}% | ${(after * 100).toFixed(1).padStart(12)}% | ${(after - before >= 0 ? '+' : '') + ((after - before) * 100).toFixed(1)}% |`,
  );
}
