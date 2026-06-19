import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { detectTypecheckSkip, isMissingTscOutput } from './typecheck-availability';

describe('isMissingTscOutput', () => {
  it('detects the npm "tsc" squatter message (deps-less worktree, #1255)', () => {
    expect(isMissingTscOutput('This is not the tsc command you are looking for')).toBe(true);
    expect(
      isMissingTscOutput('npm warn exec\nThis is not the tsc command you are looking for\n'),
    ).toBe(true);
  });

  it('is false for real type errors and empty output', () => {
    expect(isMissingTscOutput('src/x.ts(1,1): error TS2345: Argument of type ...')).toBe(false);
    expect(isMissingTscOutput('')).toBe(false);
  });
});

describe('detectTypecheckSkip', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'o8-tsc-avail-'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function makeWorktree(
    name: string,
    opts: { tsconfig?: boolean; typescriptPkg?: boolean; tscBin?: boolean },
  ): Promise<string> {
    const dir = path.join(root, name);
    await mkdir(dir, { recursive: true });
    if (opts.tsconfig) {
      await writeFile(path.join(dir, 'tsconfig.json'), '{}');
    }
    if (opts.typescriptPkg) {
      await mkdir(path.join(dir, 'node_modules', 'typescript'), { recursive: true });
      await writeFile(
        path.join(dir, 'node_modules', 'typescript', 'package.json'),
        '{"name":"typescript"}',
      );
    }
    if (opts.tscBin) {
      await mkdir(path.join(dir, 'node_modules', '.bin'), { recursive: true });
      await writeFile(path.join(dir, 'node_modules', '.bin', 'tsc'), '#!/bin/sh\n');
    }
    return dir;
  }

  it('skips when there is no tsconfig (not a TS project)', async () => {
    const result = await detectTypecheckSkip(await makeWorktree('no-tsconfig', {}));
    expect(result.skip).toBe(true);
    expect(result.reason).toMatch(/tsconfig/i);
  });

  it('skips when tsconfig exists but no local TypeScript is installed (#1255 repro)', async () => {
    const result = await detectTypecheckSkip(await makeWorktree('tsconfig-no-deps', { tsconfig: true }));
    expect(result.skip).toBe(true);
    expect(result.reason).toMatch(/typescript|node_modules/i);
  });

  it('runs the typecheck when tsconfig + node_modules/typescript exist', async () => {
    const dir = await makeWorktree('full-pkg', { tsconfig: true, typescriptPkg: true });
    expect((await detectTypecheckSkip(dir)).skip).toBe(false);
  });

  it('runs the typecheck when tsconfig + node_modules/.bin/tsc exist', async () => {
    const dir = await makeWorktree('full-bin', { tsconfig: true, tscBin: true });
    expect((await detectTypecheckSkip(dir)).skip).toBe(false);
  });
});
