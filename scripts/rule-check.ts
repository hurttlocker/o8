#!/usr/bin/env tsx
import process from 'node:process';
import { execFile } from 'node:child_process';
import { devNull } from 'node:os';
import { promisify } from 'node:util';

import { buildRuleCheckFailureMessage, type RuleCheckGitReader } from '../src/lib/supervisor/rule-check';
import { runRepositoryRuleCheck } from '../src/lib/supervisor/repository-rule-check';

const execFileAsync = promisify(execFile);

// Static analysis never opens the application credential store. Git needs only
// executable lookup and OS temporary-directory settings, with no inherited keys.
const staticGitReader: RuleCheckGitReader = (cwd, args) => {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'production', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull };
  for (const name of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  const readArgs = args[0] === 'diff'
    ? ['diff', '--no-ext-diff', '--no-textconv', ...args.slice(1)] : args;
  return execFileAsync('git', ['--no-pager', '-c', 'core.fsmonitor=false', ...readArgs], {
    cwd, env, windowsHide: true, maxBuffer: 10 * 1024 * 1024,
  });
};

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
        'ports, hardcoded /Users paths, and child-process environment boundaries.',
        'Process rules scan complete changed src files: only the central typed',
        'wrapper may import child_process values; launches must not inherit raw',
        'process.env outside the environment builder.',
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

  const result = await runRepositoryRuleCheck(process.cwd(), baseRef, staticGitReader);
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
