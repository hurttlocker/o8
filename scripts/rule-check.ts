#!/usr/bin/env tsx
import process from 'node:process';

import { buildRuleCheckFailureMessage, runRuleCheck } from '../src/lib/supervisor/rule-check';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let baseRef = 'main';
  const passthrough: string[] = [];

  for (const arg of args) {
    if (arg.startsWith('--base=')) {
      baseRef = arg.slice('--base='.length);
    } else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: npm run rule-check [-- --base=<ref>]',
        '',
        'Scans files that differ between <ref> (default: main) and the current',
        'worktree against the CLAUDE.md invariants: className, padding shorthand,',
        'rgba whites, emoji, icon-library imports, 800-line ceiling, hardcoded',
        'ports, hardcoded /Users paths.',
        '',
        'Exits 0 when clean, 1 when any violation is detected.',
      ].join('\n'));
      return;
    } else {
      passthrough.push(arg);
    }
  }

  if (passthrough.length > 0) {
    console.warn(`[rule-check] Ignoring unrecognized args: ${passthrough.join(' ')}`);
  }

  const result = await runRuleCheck(process.cwd(), baseRef);
  if (result.ok) {
    console.log(`[rule-check] OK — scanned ${result.scannedFiles} file(s), zero violations vs ${baseRef}`);
    return;
  }

  console.error(buildRuleCheckFailureMessage(result));
  process.exitCode = 1;
}

void main().catch((error) => {
  console.error('[rule-check] Unexpected failure:', error);
  process.exitCode = 1;
});
