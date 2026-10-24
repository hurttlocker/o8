import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import { runRuleCheck } from './rule-check';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const directories: string[] = [];

afterEach(() => {
  for (const cwd of directories.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe('runtime rule check scope', () => {
  it('keeps the TypeScript compiler out of the packet completion gate bundle', async () => {
    // The packaged server bundles inline every package this entry reaches.
    const result = await build({
      absWorkingDir: root,
      entryPoints: ['src/lib/supervisor/completion-verification.ts'],
      bundle: true,
      write: false,
      metafile: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      logLevel: 'silent',
    });
    const compilerImporters = Object.entries(result.metafile.inputs)
      .filter(([, input]) => input.imports.some(entry => entry.path === 'typescript'))
      .map(([file]) => file);
    expect(compilerImporters).toEqual([]);
  });

  it('does not apply o8 source boundaries to an operator repository', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'o8-rule-runtime-'));
    directories.push(cwd);
    execFileSync('git', ['init', '--quiet', cwd]);
    execFileSync('git', ['-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'baseline']);
    const file = join(cwd, 'src/server/launch.ts');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "import { spawn } from 'node:child_process';\nspawn('tool', [], { env: process.env });\n");

    const result = await runRuleCheck(cwd, 'HEAD');
    expect(result.scannedFiles).toBe(1);
    expect(result.violations.filter(v => v.rule === 'child-process-boundary')).toEqual([]);
  });
});
