import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertOrchestratorRepoPath } from './repo-preflight';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('assertOrchestratorRepoPath', () => {
  it('allows the resolved home anchor without requiring a Git work tree', () => {
    expect(() => assertOrchestratorRepoPath(homedir())).not.toThrow();
  });

  it('still rejects an arbitrary existing non-Git directory', () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), 'o8-non-git-preflight-'));
    tempDirs.push(nonGitDir);

    expect(() => assertOrchestratorRepoPath(nonGitDir))
      .toThrow(`${nonGitDir} isn't a Git repository`);
  });
});
