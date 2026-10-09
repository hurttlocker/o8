#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { formatReleaseSummary, prepareReleaseSummary } from './lib/release-summary.mjs';

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${name} value.`);
  return args[index + 1];
}
try {
  const inputPath = option('--input');
  const outputPath = option('--out');
  const cacheDir = option('--cache-dir');
  const codexPath = option('--codex');
  if (!inputPath || !outputPath) throw new Error('Usage: node scripts/release-summary.mjs --input latest-ship.json --out notes.md [--dry-run]');
  const source = readFileSync(inputPath, 'utf8');
  if (Buffer.byteLength(source) > 512_000) throw new Error('Release summary input is too large.');
  const summary = prepareReleaseSummary(JSON.parse(source), { cacheDir, codexPath, dryRun: args.includes('--dry-run') });
  writeFileSync(outputPath, formatReleaseSummary(summary), { mode: 0o600 });
  console.log(JSON.stringify({ version: summary.version, status: summary.status, cached: summary.cached, model: summary.model }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
