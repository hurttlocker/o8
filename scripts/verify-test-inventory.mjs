#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

// Compare actual Vitest discoveries and expanded it.each names, including
// skipped tests. A matching source-marker count alone misses include/exclude drift.
function inventory(paths) {
  const files = new Map();
  for (const path of paths) {
    const report = JSON.parse(readFileSync(path, 'utf8'));
    const assertions = report.testResults.reduce((sum, file) => sum + file.assertionResults.length, 0);
    assert.equal(assertions, report.numTotalTests, 'report test count disagrees with assertions');
    for (const file of report.testResults) {
      const name = relative(process.cwd(), file.name).replaceAll('\\', '/');
      assert(!files.has(name), `duplicate test file: ${name}`);
      files.set(name, file.assertionResults.map(test => ({
        name: test.fullName,
        skipped: ['skipped', 'pending', 'todo', 'disabled'].includes(test.status),
      })).sort((a, b) => a.name.localeCompare(b.name)));
    }
  }
  return [...files.entries()].sort(([a], [b]) => a.localeCompare(b));
}

const [before, after, ...shards] = process.argv.slice(2);
assert(before && after, 'usage: node scripts/verify-test-inventory.mjs before.json after.json [shard*.json]');
const baseline = inventory([before]);
assert.deepEqual(inventory([after]), baseline, 'hermetic file list, test names/count or skip state changed');
if (shards.length) assert.deepEqual(inventory(shards), baseline, 'shards must cover every test exactly once');
console.log(`[test-inventory] unchanged: ${baseline.length} files,`
  + ` ${baseline.reduce((sum, [, tests]) => sum + tests.length, 0)} tests;`
  + ` skip states unchanged${shards.length ? `; ${shards.length} shards cover every file exactly once` : ''}`);
