import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import { writeTestRunOwner } from './test-fixture-lifecycle';

interface AttachedImage {
  baseDevice: string;
  imagePath: string;
  mountPath: string;
  root: string;
}

const cleanupRoots: string[] = [];
const attachedDevices: string[] = [];

function nestedVitest(testPath: string, env: Record<string, string>) {
  return spawnSync(
    process.execPath,
    ['./node_modules/vitest/vitest.mjs', 'run', testPath, '--reporter=dot'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, ...env },
      timeout: 30_000,
    },
  );
}

function attachImage(parent: string, prefix: string, volumeName: string): AttachedImage {
  const root = mkdtempSync(path.join(parent, prefix));
  writeTestRunOwner(root);
  const mountPath = path.join(root, 'mount');
  mkdirSync(mountPath);
  const imageBase = path.join(root, 'fixture');
  execFileSync('/usr/bin/hdiutil', [
    'create', '-quiet', '-size', '16m', '-fs', 'APFS', '-volname', volumeName,
    '-type', 'SPARSE', imageBase,
  ], { stdio: 'pipe' });
  const imageName = readdirSync(root).find((name) => name.startsWith('fixture.'));
  if (!imageName) throw new Error(`hdiutil did not create an image under ${root}.`);
  const imagePath = path.join(root, imageName);
  const output = execFileSync('/usr/bin/hdiutil', [
    'attach', '-nobrowse', '-mountpoint', mountPath, imagePath,
  ], { encoding: 'utf8' });
  const baseDevice = output.split('\n')
    .map((line) => line.split('\t')[0]?.trim())
    .find((entry) => /^\/dev\/disk\d+$/.test(entry ?? ''));
  if (!baseDevice) throw new Error(`hdiutil did not report a base device: ${output}`);
  attachedDevices.push(baseDevice);
  return { baseDevice, imagePath, mountPath, root };
}

function detach(device: string): void {
  try {
    execFileSync('/usr/bin/hdiutil', ['detach', device], { stdio: 'ignore' });
  } catch {
    try {
      execFileSync('/usr/bin/hdiutil', ['detach', device, '-force'], { stdio: 'ignore' });
    } catch { /* The test assertion reports retained devices before cleanup. */ }
  }
  const index = attachedDevices.indexOf(device);
  if (index >= 0) attachedDevices.splice(index, 1);
}

afterEach(() => {
  for (const device of [...attachedDevices].reverse()) detach(device);
  for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('fixture lifecycle through consecutive Vitest suites', () => {
  it('contains os.tmpdir fixtures in the run root and removes it on process exit', () => {
    expect(os.tmpdir()).toBe(process.env.O8_TEST_RUN_DATA_ROOT);
    const parent = mkdtempSync(path.join(os.tmpdir(), 'o8-exit-cleanup-real-'));
    const markerPath = path.join(parent, 'run-root.txt');
    cleanupRoots.push(parent);
    const setupUrl = pathToFileURL(path.join(process.cwd(), 'tests/global-test-data-dir.ts')).href;
    const script = `
      const { writeFileSync } = await import('node:fs');
      const setupModule = await import(${JSON.stringify(setupUrl)});
      const setup = setupModule.default?.default ?? setupModule.default ?? setupModule;
      await setup();
      writeFileSync(${JSON.stringify(markerPath)}, process.env.O8_TEST_RUN_DATA_ROOT);
      process.exit(0);
    `;
    const child = spawnSync(process.execPath, [
      '--import=tsx', '--input-type=module', '--eval', script,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        CORTEX_IDE_DATA_DIR: '',
        O8_TEST_DATA_DIR_PINNED: '',
        O8_TEST_FIXTURE_SWEEP_PARENT: parent,
        O8_TEST_FIXTURE_MAX_AGE_MS: '1',
        O8_TEST_RUN_DATA_ROOT: '',
      },
      timeout: 30_000,
    });
    expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
    const runRoot = readFileSync(markerPath, 'utf8');
    expect(existsSync(runRoot)).toBe(false);
  });

  it('reclaims a failed fixture at the next suite start and reports its bytes', () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'o8-fixture-sweep-real-'));
    const markerPath = path.join(parent, 'leaked-path.txt');
    cleanupRoots.push(parent);
    const commonEnv = {
      O8_TEST_FIXTURE_SWEEP_PARENT: parent,
      O8_TEST_FIXTURE_MAX_AGE_MS: '1',
    };

    const failed = nestedVitest('tests/fixtures/fixture-leak-failure.test.ts', {
      ...commonEnv,
      O8_TEST_FIXTURE_LEAK_PARENT: parent,
      O8_TEST_FIXTURE_LEAK_MARKER: markerPath,
    });
    expect(failed.status, `${failed.stdout}\n${failed.stderr}`).not.toBe(0);
    const leakedPath = readFileSync(markerPath, 'utf8');
    expect(existsSync(leakedPath)).toBe(true);

    const swept = nestedVitest('tests/fixtures/fixture-sweep-probe.test.ts', {
      ...commonEnv,
      O8_TEST_EXPECT_REMOVED_PATH: leakedPath,
    });
    expect(swept.status, `${swept.stdout}\n${swept.stderr}`).toBe(0);
    expect(existsSync(leakedPath)).toBe(false);
    expect(swept.stdout).toMatch(/\[fixture-cleanup] Reclaimed [1-9]\d* fixture bytes/);
  });

  it.runIf(process.platform === 'darwin')(
    'detaches orphaned APFS images while preserving a mounted fixture directory',
    () => {
      const parent = mkdtempSync(path.join(os.tmpdir(), 'o8-fixture-mount-sweep-real-'));
      cleanupRoots.push(parent);
      const orphan = attachImage(parent, 'o8-apfs-orphan-', 'O8OrphanFixture');
      const mounted = attachImage(parent, 'o8-mounted-skip-', 'O8MountedFixture');
      const old = new Date(Date.now() - 60_000);
      utimesSync(orphan.root, old, old);
      utimesSync(mounted.root, old, old);

      const swept = nestedVitest('tests/fixtures/fixture-sweep-probe.test.ts', {
        O8_TEST_FIXTURE_SWEEP_PARENT: parent,
        O8_TEST_FIXTURE_MAX_AGE_MS: '1',
        O8_TEST_EXPECT_REMOVED_PATH: orphan.root,
        O8_TEST_EXPECT_DETACHED_IMAGE: orphan.imagePath,
        O8_TEST_EXPECT_MOUNTED_PATH: mounted.mountPath,
      });
      expect(swept.status, `${swept.stdout}\n${swept.stderr}`).toBe(0);
      expect(existsSync(orphan.root)).toBe(false);
      expect(existsSync(mounted.root)).toBe(true);
      const imageInfo = execFileSync('/usr/bin/hdiutil', ['info'], { encoding: 'utf8' });
      expect(imageInfo).not.toContain(orphan.imagePath);
      expect(imageInfo).not.toContain(`${parent}/o8-apfs-`);
      expect(imageInfo).toContain(mounted.imagePath);
      expect(swept.stdout).toMatch(/detached 1 orphaned o8-apfs-\* images/);
      expect(swept.stdout).toMatch(/skipped 1 mounted directories/);
      detach(mounted.baseDevice);
    },
  );
});
