import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Force the BYO config absent regardless of the dev machine: env.ts falls back
// to ~/.o8/github-app.pem, which exists on the primary dev box — pointing
// homedir at an empty temp dir makes getGitHubAppConfig() return null, which
// is exactly a fresh user's machine (the managed path's real precondition).
const fakeHome = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: td } = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: j } = require('node:path') as typeof import('node:path');
  return mk(j(td(), 'o8-managed-home-'));
});
vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>();
  return { ...real, homedir: () => fakeHome, default: { ...real, homedir: () => fakeHome } };
});

import {
  clearManagedGithubState,
  readManagedGithubToken,
  writeManagedGithubState,
} from '@/lib/github-broker/managed';
import { getInstallationForRepo, getInstallationToken } from '@/lib/github-broker/auth';

/**
 * Real-path seam (reachability rule): the entitlement sync persists managed
 * GitHub App state to disk, and the broker's REAL auth functions — the ones
 * every /api/panel GitHub route calls — must pick it up with no BYO env
 * config and no network. Testing readManagedGithubToken alone would be the
 * "green tests encode the premise" trap; getInstallationForRepo /
 * getInstallationToken are what actual callers reach.
 */
describe('managed GitHub App broker seam', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'o8-managed-data-'));
    process.env.CORTEX_IDE_DATA_DIR = dataDir;
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
  });

  afterEach(() => {
    clearManagedGithubState();
    delete process.env.CORTEX_IDE_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('broker auth serves the persisted managed token without any BYO config or network', async () => {
    writeManagedGithubState({
      installed: true,
      token: 'ghs_managed_test_token',
      expiresAt: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
      installationId: 4242,
      accountLogin: 'chris-example',
    });

    // The exact chain githubInstallationFetch runs for every panel route.
    const installation = await getInstallationForRepo('someone/some-repo');
    expect(installation.id).toBe(4242);
    expect(installation.account?.login).toBe('chris-example');

    const token = await getInstallationToken(installation.id);
    expect(token).toBe('ghs_managed_test_token');
  });

  it('an expiring managed token is treated as absent (falls back, never serves stale)', () => {
    writeManagedGithubState({
      installed: true,
      token: 'ghs_about_to_die',
      expiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
      installationId: 4242,
      accountLogin: 'chris-example',
    });
    expect(readManagedGithubToken()).toBeNull();
  });

  it('installed:false marker exposes the install CTA and no token', () => {
    writeManagedGithubState({
      installed: false,
      installUrl: 'https://github.com/apps/o8/installations/new',
    });
    expect(readManagedGithubToken()).toBeNull();
  });
});
