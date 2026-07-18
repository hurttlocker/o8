/**
 * #1565 — a registered repo whose folder is gone is a first-class 'missing'
 * readiness state, detected by the probe — not discovered at spawn time.
 *
 * Old behavior: every sub-probe failed soft (git errors → fallbacks), so a
 * deleted/moved checkout read as 'unknown' — or even 'ready' when a runnable
 * contract was saved — and Sydney (FKAR3B/6JWBVV) hit the same cryptic spawn
 * failure repeatedly when the fix was a one-minute re-add.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { getRepoReadiness } from '@/lib/repos/readiness';
import type { RepoSetupConfig } from '@/lib/repos/types';

const setup: RepoSetupConfig = {
  envMode: 'skip',
  envFiles: [],
  installCommand: null,
  installOnCreateWorkspace: false,
  buildCommand: null,
  runBuildOnCreateWorkspace: false,
  devCommand: 'npm run dev',
  defaultPort: null,
  workspaceIsolationPreference: 'auto',
};

describe('#1565 — missing repo folder is a first-class readiness state', () => {
  it("reports 'missing' for a localPath that no longer exists", async () => {
    const readiness = await getRepoReadiness({
      localPath: join(os.tmpdir(), 'o8-vanished-repo-that-never-existed'),
      defaultBranch: 'main',
      setup,
    });

    // Old code fell through the soft-failing probes: the saved runnable
    // contract made this read 'ready'.
    expect(readiness.state).toBe('missing');
    expect(readiness.summary).toContain('not found');
    expect(readiness.nextAction).toBeTruthy();
  });

  it('an existing git repo still resolves normally', async () => {
    const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-readiness-real-'));
    execFileSync('git', ['init', '-q', repoPath]);

    const readiness = await getRepoReadiness({
      localPath: repoPath,
      defaultBranch: 'main',
      setup,
    });

    expect(readiness.state).not.toBe('missing');
  });
});
