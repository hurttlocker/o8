import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];

function nestedSweep(parent: string, env: Record<string, string> = {}) {
  return spawnSync(
    process.execPath,
    ['./node_modules/vitest/vitest.mjs', 'run', 'tests/fixtures/fixture-sweep-probe.test.ts', '--reporter=dot'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        CORTEX_IDE_DATA_DIR: '',
        O8_TEST_DATA_DIR_PINNED: '',
        O8_TEST_RUN_DATA_ROOT: '',
        O8_TEST_FIXTURE_SWEEP_PARENT: parent,
        O8_TEST_FIXTURE_MAX_AGE_MS: '1',
        ...env,
      },
      timeout: 30_000,
    },
  );
}

function staleProductDirectory(parent: string, name: string): string {
  const target = path.join(parent, name);
  mkdirSync(target);
  writeFileSync(path.join(target, 'product-state.bin'), 'keep\n');
  const stale = new Date(Date.now() - 60_000);
  utimesSync(target, stale, stale);
  return target;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('fixture sweeper ownership through suite startup', () => {
  it('refuses a sweep parent outside a real temporary root', () => {
    const parent = mkdtempSync(path.join(process.cwd(), '.o8-sweep-outside-temp-'));
    roots.push(parent);
    const productDirectory = staleProductDirectory(parent, 'o8-product-owned-state');

    const swept = nestedSweep(parent);

    expect(swept.status, `${swept.stdout}\n${swept.stderr}`).not.toBe(0);
    expect(`${swept.stdout}\n${swept.stderr}`).toContain(
      'Fixture sweep parent is outside a real temporary root',
    );
    expect(existsSync(productDirectory)).toBe(true);
  });

  it('leaves a matching stale directory without an ownership sentinel alone', () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'o8-sweep-owner-parent-'));
    roots.push(parent);
    const productDirectory = staleProductDirectory(parent, 'o8-rollback-product-state');

    const swept = nestedSweep(parent, {
      O8_TEST_EXPECT_RETAINED_PATH: productDirectory,
    });

    expect(swept.status, `${swept.stdout}\n${swept.stderr}`).toBe(0);
    expect(existsSync(productDirectory)).toBe(true);
  });
});
