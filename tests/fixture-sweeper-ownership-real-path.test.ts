import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { TEST_RUN_OWNER_FILE, TEST_RUN_RETAIN_FILE } from './test-fixture-lifecycle';

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

  it.each(['', 'configured'])('default startup preserves shared siblings with %s data configuration', (configuration) => {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'o8-sweep-default-parent-'));
    roots.push(parent);
    const sibling = staleProductDirectory(parent, 'o8-unrelated-fixture');
    writeFileSync(path.join(sibling, TEST_RUN_OWNER_FILE), JSON.stringify({
      pid: Number.MAX_SAFE_INTEGER, startedAt: new Date(0).toISOString(),
    }));
    utimesSync(sibling, new Date(0), new Date(0));
    const configured = path.join(parent, 'configured');
    mkdirSync(configured);
    const swept = nestedSweep('', {
      TMPDIR: parent, TMP: parent, TEMP: parent,
      CORTEX_IDE_DATA_DIR: configuration ? configured : '',
      O8_TEST_EXPECT_RETAINED_PATH: sibling,
    });
    expect(swept.status, `${swept.stdout}\n${swept.stderr}`).toBe(0);
    expect(readFileSync(path.join(sibling, 'product-state.bin'), 'utf8')).toBe('keep\n');
  });

  it.each(['o8-test-data-run-Ab12Cd', 'o8-apfs-held', 'o8-legacy-held'])(
    'preserves live, retained and unknown owners for %s', (name) => {
      const parent = mkdtempSync(path.join(os.tmpdir(), 'o8-sweep-holds-parent-'));
      roots.push(parent);
      for (const kind of ['live', 'retained', 'unknown']) {
        const category = path.join(parent, kind);
        mkdirSync(category);
        const fixture = staleProductDirectory(category, name);
        writeFileSync(path.join(fixture, TEST_RUN_OWNER_FILE), JSON.stringify({
          pid: kind === 'live' ? process.pid : Number.MAX_SAFE_INTEGER,
          startedAt: new Date(0).toISOString(),
        }));
        if (kind === 'retained') writeFileSync(path.join(fixture, TEST_RUN_RETAIN_FILE), '{}');
        if (kind === 'unknown') writeFileSync(path.join(fixture, TEST_RUN_OWNER_FILE), '{broken');
        utimesSync(fixture, new Date(0), new Date(0));
        const swept = nestedSweep(category, { O8_TEST_EXPECT_RETAINED_PATH: fixture });
        expect(swept.status, `${swept.stdout}\n${swept.stderr}`).toBe(0);
        expect(existsSync(fixture)).toBe(true);
      }
    }, 60_000,
  );

  it('sweeps a deeply nested fixture and persists an exact receipt outside it', () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'o8-sweep-receipt-parent-'));
    roots.push(parent);
    const fixture = staleProductDirectory(parent, 'o8-dead-fixture');
    mkdirSync(path.join(fixture, ...Array.from({ length: 32 }, () => 'level')), { recursive: true });
    writeFileSync(path.join(fixture, TEST_RUN_OWNER_FILE), JSON.stringify({
      pid: Number.MAX_SAFE_INTEGER, startedAt: new Date(0).toISOString(),
    }));
    utimesSync(fixture, new Date(0), new Date(0));
    const swept = nestedSweep(parent, { O8_TEST_EXPECT_REMOVED_PATH: fixture });
    expect(swept.status, `${swept.stdout}\n${swept.stderr}`).toBe(0);
    const receipts = readdirSync(parent).filter((name) => name.startsWith('.o8-fixture-sweep-'));
    expect(receipts).toHaveLength(1);
    const receipt = JSON.parse(readFileSync(path.join(parent, receipts[0], 'receipt.json'), 'utf8'));
    expect(receipt.removedPaths).toEqual([fixture]);
    expect(receipt.pendingRemovalPaths).toEqual([]);
    expect(receipt.reclaimedBytes).toBeGreaterThan(0);
    expect(existsSync(fixture)).toBe(false);
  });


  it.each(['live', 'retained', 'replaced', 'nested-changed', 'nested-missing'])(
    'holds %s ownership introduced after discovery through global setup', (change) => {
      const parent = mkdtempSync(path.join(os.tmpdir(), 'o8-sweep-race-parent-'));
      roots.push(parent);
      const fixture = staleProductDirectory(parent, 'o8-dead-fixture');
      const nested = path.join(fixture, 'nested');
      mkdirSync(nested);
      const deadOwner = JSON.stringify({ pid: Number.MAX_SAFE_INTEGER, startedAt: new Date(0).toISOString() });
      for (const root of [fixture, nested]) writeFileSync(path.join(root, TEST_RUN_OWNER_FILE), deadOwner);
      utimesSync(fixture, new Date(0), new Date(0));
      // Inject the ownership change at the persisted pre-delete boundary. The
      // production global setup, discovery, mount checks and rm stay real.
      const script = `
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        const originalRename = fs.promises.rename;
        let changed = false;
        fs.promises.rename = async (from, to) => {
          await originalRename(from, to);
          if (changed || !String(to).endsWith('receipt.json')) return;
          const receipt = JSON.parse(fs.readFileSync(to, 'utf8'));
          if (!receipt.pendingRemovalPaths.includes(${JSON.stringify(fixture)})) return;
          changed = true;
          const root = ${JSON.stringify(fixture)};
          const owner = ${JSON.stringify(TEST_RUN_OWNER_FILE)};
          const change = ${JSON.stringify(change)};
          if (change === 'live') fs.writeFileSync(root + '/' + owner, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
          if (change === 'retained') fs.writeFileSync(root + '/' + ${JSON.stringify(TEST_RUN_RETAIN_FILE)}, '{}');
          if (change === 'replaced') {
            fs.renameSync(root, root + '-preserved');
            fs.mkdirSync(root);
            fs.writeFileSync(root + '/' + owner, ${JSON.stringify(deadOwner)});
          }
          if (change === 'nested-changed') fs.writeFileSync(root + '/nested/' + owner, JSON.stringify({ pid: Number.MAX_SAFE_INTEGER - 1, startedAt: new Date(0).toISOString() }));
          if (change === 'nested-missing') fs.unlinkSync(root + '/nested/' + owner);
        };
        syncBuiltinESMExports();
        const imported = await import(${JSON.stringify(pathToFileURL(path.join(process.cwd(), 'tests/global-test-data-dir.ts')).href)});
        const setup = imported.default?.default ?? imported.default;
        const teardown = await setup();
        await teardown();
        if (!changed) throw new Error('ownership change was not exercised');
      `;
      const swept = spawnSync(process.execPath, ['--import=tsx', '--input-type=module', '--eval', script], {
        encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, CORTEX_IDE_DATA_DIR: '', O8_TEST_FIXTURE_SWEEP_PARENT: parent, O8_TEST_FIXTURE_MAX_AGE_MS: '1' },
      });
      expect(swept.status, `${swept.stdout}\n${swept.stderr}`).toBe(0);
      expect(existsSync(fixture)).toBe(true);
      const receiptName = readdirSync(parent).find((name) => name.startsWith('.o8-fixture-sweep-'))!;
      const receipt = JSON.parse(readFileSync(path.join(parent, receiptName, 'receipt.json'), 'utf8'));
      expect(receipt.removedPaths).toEqual([]);
      expect([...receipt.skippedLivePaths, ...receipt.skippedRetainedPaths, ...receipt.skippedOwnershipPaths]).toContain(fixture);
    },
  );


  it.each(['success', 'live', 'retained', 'force-live', 'force-retained', 'recycled'])(
    'authorizes APFS detach at the OS boundary: %s', (scenario) => {
      const parent = mkdtempSync(path.join(os.tmpdir(), 'o8-sweep-apfs-parent-'));
      roots.push(parent);
      const fixture = staleProductDirectory(parent, 'o8-apfs-fixture');
      const image = path.join(fixture, 'fixture.sparseimage');
      writeFileSync(image, 'fixture image');
      writeFileSync(path.join(fixture, TEST_RUN_OWNER_FILE), JSON.stringify({
        pid: Number.MAX_SAFE_INTEGER, startedAt: new Date(0).toISOString(),
      }));
      utimesSync(fixture, new Date(0), new Date(0));
      // Linux supplies only the hdiutil boundary; all filesystem ownership,
      // setup, receipts and deletion paths use the production implementation.
      const script = `
        import fs from 'node:fs';
        import cp from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        import { promisify } from 'node:util';
        const original = promisify(cp.execFile);
        const root = ${JSON.stringify(fixture)};
        const image = ${JSON.stringify(image)};
        const scenario = ${JSON.stringify(scenario)};
        const calls = [];
        let inspections = 0;
        cp.execFile = Object.assign(() => { throw new Error('unexpected callback invocation'); }, {
          [promisify.custom]: async (file, args, options) => {
            if (file !== '/usr/bin/hdiutil') return original(file, args, options);
            if (args[0] === 'info') {
              inspections++;
              const currentImage = scenario === 'recycled' && inspections > 1 ? image + '-other' : image;
              return { stdout: 'image-path : ' + currentImage + '\\n/dev/disk999\\tslice\\n', stderr: '' };
            }
            calls.push(args);
            if (scenario.startsWith('force-') && calls.length === 1) {
              if (scenario === 'force-live') fs.writeFileSync(root + '/' + ${JSON.stringify(TEST_RUN_OWNER_FILE)}, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
              else fs.writeFileSync(root + '/' + ${JSON.stringify(TEST_RUN_RETAIN_FILE)}, '{}');
              throw new Error('busy fixture image');
            }
            return { stdout: '', stderr: '' };
          },
        });
        syncBuiltinESMExports();
        const imported = await import(${JSON.stringify(pathToFileURL(path.join(process.cwd(), 'tests/global-test-data-dir.ts')).href)});
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        if (scenario === 'live') fs.writeFileSync(root + '/' + ${JSON.stringify(TEST_RUN_OWNER_FILE)}, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
        if (scenario === 'retained') fs.writeFileSync(root + '/' + ${JSON.stringify(TEST_RUN_RETAIN_FILE)}, '{}');
        const setup = imported.default?.default ?? imported.default;
        const teardown = await setup();
        await teardown();
        fs.writeFileSync(${JSON.stringify(path.join(parent, 'calls.json'))}, JSON.stringify(calls));
      `;
      const swept = spawnSync(process.execPath, ['--import=tsx', '--input-type=module', '--eval', script], {
        encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, CORTEX_IDE_DATA_DIR: '', O8_TEST_FIXTURE_SWEEP_PARENT: parent, O8_TEST_FIXTURE_MAX_AGE_MS: '1' },
      });
      expect(swept.status, `${swept.stdout}\n${swept.stderr}`).toBe(0);
      const calls = JSON.parse(readFileSync(path.join(parent, 'calls.json'), 'utf8'));
      expect(calls).toHaveLength(scenario === 'success' || scenario.startsWith('force-') ? 1 : 0);
      expect(calls.some((args: string[]) => args.includes('-force'))).toBe(false);
      expect(existsSync(fixture)).toBe(scenario !== 'success');
      const receiptName = readdirSync(parent).find((name) => name.startsWith('.o8-fixture-sweep-'))!;
      const receipt = JSON.parse(readFileSync(path.join(parent, receiptName, 'receipt.json'), 'utf8'));
      expect(receipt.detachedImages).toEqual(scenario === 'success' ? [image] : []);
      expect(receipt.retainedImages).toEqual(scenario === 'success' ? [] : [fixture]);
    },
  );

});
