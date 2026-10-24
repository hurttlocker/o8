#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

const [reportPath, outputPath = 'config/vitest/hermetic-durations.json'] = process.argv.slice(2);
assert(reportPath, 'usage: node scripts/update-hermetic-durations.mjs timings.json [summary.json]');
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
assert.equal(report.schema, 'o8/test-timings/v1');
const entries = new Map();
for (const file of report.files) {
  assert(!entries.has(file.path), `duplicate test file: ${file.path}`);
  assert(Number.isFinite(file.totalMs) && file.totalMs >= 0, 'invalid duration');
  entries.set(file.path, file);
}
assert(entries.size > 0, 'timing report is empty');
const sorted = [...entries.values()].sort((a, b) => b.totalMs - a.totalMs || a.path.localeCompare(b.path));
const median = (files, fallback) => {
  const values = files.map(file => file.totalMs).sort((a, b) => a - b);
  return Math.max(1, Math.round(values[Math.floor(values.length / 2)] ?? fallback));
};
// Keep only outliers and two cost estimates in Git; full records are artifacts.
const ordinary = sorted.slice(30);
const summary = {
  defaultMs: median(ordinary.filter(file => file.environmentMs < 50), 100),
  jsdomMs: median(ordinary.filter(file => file.environmentMs >= 50), 1000),
  slowFiles: Object.fromEntries(sorted.slice(0, 30).map(file => [file.path, Math.max(1, Math.round(file.totalMs))])),
};
writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`[test-timing] summarized ${entries.size} files into ${Object.keys(summary.slowFiles).length} outliers`);
