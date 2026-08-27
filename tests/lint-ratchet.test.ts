import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

type EslintCli = {
  execute(args: string[], text: string | null, allowFlatConfig?: boolean): Promise<number>;
};

const require = createRequire(import.meta.url);
const eslintRoot = dirname(require.resolve('eslint/package.json'));
const eslintCli = require(join(eslintRoot, 'lib/cli.js')) as EslintCli;

function runEslint(file: string, maxWarnings: number): Promise<number> {
  return eslintCli.execute([
    process.execPath,
    'eslint',
    file,
    '--no-config-lookup',
    '--rule',
    'no-unused-vars: warn',
    '--max-warnings',
    String(maxWarnings),
  ], null, true);
}

describe('lint warning ratchet', () => {
  it('fails above the warning ceiling and passes at the ceiling', async () => {
    const root = mkdtempSync(join(tmpdir(), 'o8-lint-ratchet-'));
    const fixture = join(root, 'warning.js');
    writeFileSync(fixture, 'const unused = 1;\n');

    try {
      expect(await runEslint(fixture, 0)).not.toBe(0);
      expect(await runEslint(fixture, 1)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
