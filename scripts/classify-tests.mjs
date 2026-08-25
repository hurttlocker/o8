#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTestClassification } from './lib/test-classification.mjs';

const root = process.cwd();
const manifestPath = join(root, 'tests/test-classification.json');
const next = `${JSON.stringify(buildTestClassification(root), null, 2)}\n`;
const mode = process.argv[2] || '--check';

if (mode === '--write') {
  writeFileSync(manifestPath, next);
  const manifest = JSON.parse(next);
  console.log(`[test-classification] ${manifest.hermeticTests} hermetic, ${manifest.resourceOwningTests} resource-owning`);
  process.exit(0);
}
if (mode !== '--check') {
  console.error('usage: node scripts/classify-tests.mjs --check|--write');
  process.exit(1);
}
const current = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : '';
if (current !== next) {
  console.error('[test-classification] manifest drifted; run npm run test:classify');
  process.exit(1);
}
console.log('[test-classification] manifest matches resource-owning source markers');
