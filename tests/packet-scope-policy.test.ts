import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { resolvePacketScope } from '@/lib/orchestrator/packet-scope-policy';

const tempDirs: string[] = [];

function createRepoFixture(): string {
  const repoPath = mkdtempSync(join(tmpdir(), 'o8-packet-scope-policy-'));
  tempDirs.push(repoPath);
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(join(repoPath, 'src', 'existing.ts'), 'export const existing = true;\n');
  return repoPath;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('packet scope path scraper', () => {
  it('drops Git ranges and dotted identifiers while retaining an existing repo path', () => {
    const repoPath = createRepoFixture();
    const resolution = resolvePacketScope({
      title: 'Repair the scoped file',
      summary: 'Compare ead1b7a15..HEAD and open_lane.baseCommit before editing src/existing.ts.',
      workspaceTargetPath: repoPath,
      predictedFiles: ['ead1b7a15..HEAD', 'open_lane.baseCommit', 'src/existing.ts'],
    });

    expect(resolution.predictedPaths).toEqual(['src/existing.ts']);
    expect(resolution.allowedPaths).toEqual(['src/existing.ts']);
    expect(resolution.source).toBe('prediction');
  });

  it('admits path-shaped new files inside the repo, including known root extensions', () => {
    const repoPath = createRepoFixture();
    const resolution = resolvePacketScope({
      title: 'Add src/new-module.ts and root-test.ts',
      summary: 'Do not treat event.payloadField as a file.',
      workspaceTargetPath: repoPath,
      predictedFiles: ['src/new-module.ts', 'root-test.ts', 'event.payloadField'],
    });

    expect(resolution.predictedPaths).toEqual(['src/new-module.ts', 'root-test.ts']);
    expect(resolution.allowedPaths).toEqual(['src/new-module.ts', 'root-test.ts']);
  });
});
