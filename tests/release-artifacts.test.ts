import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  verifyReleaseArtifactManifest,
  writeReleaseArtifactManifest,
} from '../scripts/lib/release-artifacts.mjs';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function makeArtifact() {
  const root = mkdtempSync(join(tmpdir(), 'o8-release-artifact-'));
  roots.push(root);
  mkdirSync(join(root, 'out', 'frontend'), { recursive: true });
  mkdirSync(join(root, 'src-tauri', 'helpers'), { recursive: true });
  writeFileSync(join(root, 'out', 'frontend', 'index.html'), '<h1>verified</h1>');
  for (const name of [
    'speech-local',
    'speech-local-aarch64-apple-darwin',
    'speech-local-x86_64-apple-darwin',
  ]) {
    writeFileSync(join(root, 'src-tauri', 'helpers', name), `binary-${name}`);
  }
  return root;
}

describe('release artifact provenance', () => {
  it('reuses only an exact recipe with the exact output set and checksums', () => {
    const root = makeArtifact();
    const recipe = { recipeSha256: 'recipe-a', head: 'head-a', version: '0.1.999' };
    const written = writeReleaseArtifactManifest(root, recipe);

    expect(written.manifest.outputs.length).toBe(4);
    expect(verifyReleaseArtifactManifest(root, recipe)).toMatchObject({ reusable: true });
    expect(verifyReleaseArtifactManifest(root, { ...recipe, recipeSha256: 'recipe-b' }))
      .toMatchObject({ reusable: false, reason: 'recipe_mismatch' });
    expect(verifyReleaseArtifactManifest(root, { ...recipe, worktreeClean: false }))
      .toMatchObject({ reusable: false, reason: 'dirty_worktree' });

    writeFileSync(join(root, 'out', 'frontend', 'index.html'), '<h1>mutated</h1>');
    expect(verifyReleaseArtifactManifest(root, recipe)).toMatchObject({
      reusable: false,
      reason: 'checksum_mismatch:out/frontend/index.html',
    });
  });

  it('rejects an extra output that was never verified', () => {
    const root = makeArtifact();
    const recipe = { recipeSha256: 'recipe-a' };
    writeReleaseArtifactManifest(root, recipe);
    writeFileSync(join(root, 'out', 'frontend', 'late.js'), 'unverified');
    expect(verifyReleaseArtifactManifest(root, recipe)).toMatchObject({
      reusable: false,
      reason: 'output_set_mismatch',
    });
  });
});
