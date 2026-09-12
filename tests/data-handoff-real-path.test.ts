import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync,
  rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const sourceRoot = process.cwd();
const childConfig = path.join(sourceRoot, 'tests/fixtures/data-handoff-real-path/child.vitest.config.ts');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function childContext() {
  const temp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-data-handoff-child-')));
  roots.push(temp);
  const env = { ...process.env };
  for (const key of [
    'CORTEX_IDE_DATA_DIR', 'O8_DATA_DIR', 'O8_TEST_RUN_DATA_ROOT',
    'O8_TEST_DATA_DIR_PINNED', 'O8_TEST_FIXTURE_SWEEP_PARENT',
  ]) delete env[key];
  // Even the pre-fix run may sweep its temporary parent. Keep that parent
  // inside this test's ownership instead of exposing the shared temp root.
  Object.assign(env, { TMPDIR: temp, TMP: temp, TEMP: temp });
  const marker = path.join(temp, 'ran.txt');
  env.O8_DATA_HANDOFF_PROBE_MARKER = marker;
  return { temp, marker, env };
}

function runChild(env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, [
    path.join(sourceRoot, 'node_modules/vitest/vitest.mjs'), 'run', '--config', childConfig,
  ], { cwd: sourceRoot, env, encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function makeSurrogate(): string {
  const surrogate = mkdtempSync(path.join(sourceRoot, '.o8-data-handoff-surrogate-'));
  roots.push(surrogate);
  writeFileSync(path.join(surrogate, 'profile-marker.json'), '{"live":true}\n');
  return surrogate;
}

function expectProbeInside(marker: string, parent: string) {
  const output = readFileSync(marker, 'utf8');
  expect(output).toMatch(/^ran:/);
  const used = output.slice('ran:'.length).trim();
  const relative = path.relative(realpathSync(parent), used);
  expect(relative).not.toBe('');
  expect(relative.startsWith('..')).toBe(false);
  expect(path.isAbsolute(relative)).toBe(false);
  expect(path.basename(used)).toMatch(/^vitest-worker-/);
  expect(existsSync(path.dirname(used))).toBe(false);
}

describe('packet test data handoff through global setup and a real test body', () => {
  it.each(['existing', 'missing'] as const)('isolates an inherited %s application path without sweeping siblings', (kind) => {
    const { temp, marker, env } = childContext();
    const surrogate = makeSurrogate();
    const inherited = kind === 'existing' ? surrogate : path.join(surrogate, 'missing');
    const before = readdirSync(surrogate).sort();
    const sibling = path.join(temp, 'o8-unrelated-fixture');
    mkdirSync(sibling);
    writeFileSync(path.join(sibling, 'keep'), 'preserve');
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    writeFileSync(path.join(sibling, '.o8-test-run-owner.json'), JSON.stringify({
      pid: Number.MAX_SAFE_INTEGER, startedAt: stale.toISOString(),
    }));
    utimesSync(sibling, stale, stale);
    env.CORTEX_IDE_DATA_DIR = inherited;

    const result = runChild(env);

    expect(result.status, result.output).toBe(0);
    expect(readdirSync(surrogate).sort()).toEqual(before);
    expect(readFileSync(path.join(surrogate, 'profile-marker.json'), 'utf8')).toBe('{"live":true}\n');
    expect(readFileSync(path.join(sibling, 'keep'), 'utf8')).toBe('preserve');
    expectProbeInside(marker, temp);
  }, 60_000);

  it.skipIf(process.platform === 'win32').each(['existing', 'missing'] as const)('does not trust a temporary symlink to an %s non-temporary path', (kind) => {
    const { temp, marker, env } = childContext();
    const surrogate = makeSurrogate();
    const alias = path.join(temp, 'profile-link');
    symlinkSync(surrogate, alias, 'dir');
    const before = readdirSync(surrogate).sort();
    env.CORTEX_IDE_DATA_DIR = kind === 'existing' ? alias : path.join(alias, 'missing');

    const result = runChild(env);

    expect(result.status, result.output).toBe(0);
    expect(readdirSync(surrogate).sort()).toEqual(before);
    expectProbeInside(marker, temp);
  }, 60_000);

  it.each(['existing', 'missing'] as const)('rejects an explicit %s unsafe sweep target before creating anything there', (kind) => {
    const { marker, env } = childContext();
    const surrogate = makeSurrogate();
    const before = readdirSync(surrogate).sort();
    env.CORTEX_IDE_DATA_DIR = surrogate;
    env.O8_TEST_FIXTURE_SWEEP_PARENT = kind === 'existing' ? surrogate : path.join(surrogate, 'missing');

    const result = runChild(env);

    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/outside a real temporary root/);
    expect(readdirSync(surrogate).sort()).toEqual(before);
    expect(existsSync(marker)).toBe(false);
  }, 60_000);

  it('honors an existing real temporary configured parent', () => {
    const { temp, marker, env } = childContext();
    const configured = path.join(temp, 'configured');
    mkdirSync(configured);
    env.CORTEX_IDE_DATA_DIR = configured;

    const result = runChild(env);

    expect(result.status, result.output).toBe(0);
    expectProbeInside(marker, configured);
  }, 60_000);
});
