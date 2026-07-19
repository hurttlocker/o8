import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const tsconfigPath = join(repoRoot, 'tsconfig.json');
const originalTsconfig = readFileSync(tsconfigPath, 'utf8');

function runNodeModule(modulePath, args) {
  const result = spawnSync(process.execPath, [require.resolve(modulePath), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

rmSync(join(repoRoot, '.next', 'types'), { recursive: true, force: true });
rmSync(join(repoRoot, '.next', 'dev', 'types'), { recursive: true, force: true });

let typegenStatus = 1;
try {
  typegenStatus = runNodeModule('next/dist/bin/next', ['typegen']);
} finally {
  if (readFileSync(tsconfigPath, 'utf8') !== originalTsconfig) {
    writeFileSync(tsconfigPath, originalTsconfig, 'utf8');
    process.stderr.write('[typecheck] Restored tsconfig.json after Next type generation.\n');
  }
}

if (typegenStatus !== 0) process.exit(typegenStatus);
if (process.argv.includes('--typegen-only')) process.exit(0);
process.exit(runNodeModule('typescript/bin/tsc', ['--noEmit']));
