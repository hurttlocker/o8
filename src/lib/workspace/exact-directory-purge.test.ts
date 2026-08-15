import { spawn } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { captureExactDirectoryManifest, purgeExactDirectory } from './exact-directory-purge';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('exact directory purge', () => {
  it('refuses a hard link created after tree capture without truncating either name', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'o8-exact-purge-hardlink-'));
    roots.push(root);
    const directoryPath = path.join(root, 'retired-workspace');
    const sourcePath = path.join(directoryPath, 'owned.txt');
    const externalPath = path.join(root, 'external-hardlink.txt');
    mkdirSync(directoryPath);
    writeFileSync(sourcePath, 'preserve these bytes');
    const stat = await lstat(directoryPath);

    await expect(purgeExactDirectory(
      directoryPath,
      { device: stat.dev, inode: stat.ino },
      undefined,
      async () => { linkSync(sourcePath, externalPath); },
    )).rejects.toThrow('identity changed after capture');
    expect(readFileSync(sourcePath, 'utf8')).toBe('preserve these bytes');
    expect(readFileSync(externalPath, 'utf8')).toBe('preserve these bytes');
  });

  it('releases both internal hardlink names without treating the first unlink as drift', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'o8-exact-purge-internal-hardlink-'));
    roots.push(root);
    const directoryPath = path.join(root, 'retired-workspace');
    const firstPath = path.join(directoryPath, 'first.txt');
    mkdirSync(directoryPath);
    writeFileSync(firstPath, 'owned shared bytes');
    linkSync(firstPath, path.join(directoryPath, 'second.txt'));
    const stat = await lstat(directoryPath);

    await expect(purgeExactDirectory(
      directoryPath,
      { device: stat.dev, inode: stat.ino },
    )).resolves.toBeUndefined();
    expect(() => readFileSync(firstPath, 'utf8')).toThrow();
  });

  it('resumes an exact monotonic manifest after process death during namespace release', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'o8-exact-purge-namespace-crash-'));
    roots.push(root);
    const directoryPath = path.join(root, 'retired-workspace');
    mkdirSync(directoryPath);
    writeFileSync(path.join(directoryPath, 'first.txt'), 'first bytes');
    writeFileSync(path.join(directoryPath, 'second.txt'), 'second bytes');
    writeFileSync(path.join(directoryPath, 'third.txt'), 'third bytes');
    const stat = await lstat(directoryPath);
    const identity = { device: stat.dev, inode: stat.ino };
    const manifest = await captureExactDirectoryManifest(directoryPath, identity);
    const markerPath = path.join(root, 'namespace-release.marker');
    const runnerPath = path.join(root, 'namespace-crash-runner.ts');
    const moduleUrl = pathToFileURL(
      path.join(process.cwd(), 'src/lib/workspace/exact-directory-purge.ts'),
    ).href;
    writeFileSync(runnerPath, `
      import { purgeExactDirectory } from ${JSON.stringify(moduleUrl)};
      const input = JSON.parse(process.env.O8_PURGE_TEST_INPUT);
      void purgeExactDirectory(
        input.directoryPath,
        input.identity,
        undefined,
        undefined,
        undefined,
        input.manifest.fingerprint,
        input.manifest.entries,
      );
    `);
    const child = spawn(process.execPath, ['--import', 'tsx', runnerPath], {
      cwd: process.cwd(),
      detached: true,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        O8_TEST_PURGE_STOP_MARKER: markerPath,
        O8_PURGE_TEST_INPUT: JSON.stringify({ directoryPath, identity, manifest }),
      },
      stdio: 'ignore',
    });
    const deadline = Date.now() + 15_000;
    while (!existsSync(markerPath)) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error('Exact purge crash child exited before namespace release.');
      }
      if (Date.now() >= deadline) throw new Error('Exact purge crash child timed out.');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    process.kill(-child.pid!, 'SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    expect(readdirSync(directoryPath).length).toBeGreaterThan(0);

    await expect(purgeExactDirectory(
      directoryPath,
      identity,
      undefined,
      undefined,
      undefined,
      manifest.fingerprint,
      manifest.entries,
    )).resolves.toBeUndefined();
    expect(existsSync(directoryPath)).toBe(false);
  }, 30_000);
});
