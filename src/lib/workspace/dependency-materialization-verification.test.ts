import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DependencyMaterializationIncompleteError,
  isDependencyMaterializationIncomplete,
  verifyDependencyMaterialization,
} from './dependency-materialization-verification';

const workspaces: string[] = [];

function workspace(scripts: Record<string, string>, binaries: string[] = []): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'o8-dependency-verification-'));
  workspaces.push(root);
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts }));
  const binRoot = path.join(root, 'node_modules', '.bin');
  mkdirSync(binRoot, { recursive: true });
  for (const binary of binaries) {
    const binaryPath = path.join(binRoot, binary);
    writeFileSync(binaryPath, '#!/bin/sh\nexit 0\n');
    chmodSync(binaryPath, 0o755);
  }
  return root;
}

afterEach(() => {
  for (const root of workspaces.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('dependency materialization verification', () => {
  it('resolves the repository typecheck chain through one package script', async () => {
    const root = workspace({
      typecheck: 'npm run verify:routes && node scripts/typecheck.mjs',
      'verify:routes': 'vitest run tests/route-coverage.test.ts -t "route module shape"',
    });

    const result = await verifyDependencyMaterialization(root);

    expect(result.scriptBinaries.typecheck).toEqual(['node', 'vitest']);
    expect(result.requiredBinaries).toEqual(['node', 'vitest']);
    expect(result.verifiedBinaries).toEqual(['node']);
    expect(result.missingBinaries).toEqual(['vitest']);
  });

  it.each([
    ['npx vitest run', 'npx'],
    ['pnpm exec vitest run', 'pnpm exec'],
    ['yarn vitest run', 'yarn'],
  ])('requires the wrapped binary for %s', async (script) => {
    const result = await verifyDependencyMaterialization(workspace({ test: script }));

    expect(result.requiredBinaries).toEqual(['vitest']);
    expect(result.missingBinaries).toEqual(['vitest']);
  });

  it('verifies cross-env itself as the first local binary', async () => {
    const result = await verifyDependencyMaterialization(workspace({
      test: 'cross-env NODE_ENV=test vitest run',
    }, ['vitest']));

    expect(result.requiredBinaries).toEqual(['cross-env']);
    expect(result.missingBinaries).toEqual(['cross-env']);
  });

  it('verifies every chained command segment', async () => {
    const result = await verifyDependencyMaterialization(workspace({
      lint: 'eslint . && tsc --noEmit',
    }, ['eslint']));

    expect(result.requiredBinaries).toEqual(['eslint', 'tsc']);
    expect(result.verifiedBinaries).toEqual(['eslint']);
    expect(result.missingBinaries).toEqual(['tsc']);
  });

  it('resolves node --run through the same bounded package-script path', async () => {
    const result = await verifyDependencyMaterialization(workspace({
      typecheck: 'node --run verify:routes',
      'verify:routes': 'vitest run tests/route-coverage.test.ts',
    }));

    expect(result.requiredBinaries).toEqual(['vitest']);
    expect(result.missingBinaries).toEqual(['vitest']);
  });

  it('returns a structured incomplete result for malformed package.json', async () => {
    const root = workspace({});
    writeFileSync(path.join(root, 'package.json'), '{ nope');

    const result = await verifyDependencyMaterialization(root);
    const blocker = new DependencyMaterializationIncompleteError(result, false, null);

    expect(isDependencyMaterializationIncomplete(result)).toBe(true);
    expect(result.unreadableFiles).toEqual(['package.json']);
    expect(blocker.message).toContain('package.json');
  });
});
