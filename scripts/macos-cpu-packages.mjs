#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { prepareMacosCpuPackages } from './lib/macos-cpu-packages.mjs';

try {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--root')) {
    throw new Error('usage: node scripts/macos-cpu-packages.mjs [--root <release-checkout>]');
  }
  const root = resolve(args[1] || process.cwd());
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  console.log(JSON.stringify({
    packages: prepareMacosCpuPackages(root, version),
    acceptance: 'prepared only; unsigned and unpublished',
  }, null, 2));
} catch (error) {
  console.error(`[macos-cpu-packages] ${error.message}`);
  process.exitCode = 1;
}
