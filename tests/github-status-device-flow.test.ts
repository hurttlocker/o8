import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/github-broker/status', () => ({
  getGitHubBrokerStatus: vi.fn(async () => ({ configured: false })),
}));

vi.mock('@/lib/repos/registry', () => ({
  listRepos: vi.fn(async () => []),
}));

/**
 * Real-path test for the config seam behind issue #1334.
 *
 * Onboarding step 2 gates its "Connect GitHub" CTA on the `deviceFlowEnabled`
 * flag returned by GET /api/panel/github-status, which is derived solely from
 * the presence of GITHUB_OAUTH_CLIENT_ID. This drives the ACTUAL route handler
 * (not a helper in isolation) and asserts the flag tracks the env var — the
 * contract the fixed onboarding UI depends on to decide device-flow vs. the
 * local-folder fallback.
 */

const ORIGINAL = process.env.GITHUB_OAUTH_CLIENT_ID;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.GITHUB_OAUTH_CLIENT_ID;
  else process.env.GITHUB_OAUTH_CLIENT_ID = ORIGINAL;
});

async function readDeviceFlowEnabled(): Promise<boolean> {
  const { GET } = await import('@/app/api/panel/github-status/route');
  const res = await GET();
  const body = await res.json() as { deviceFlowEnabled?: boolean };
  return Boolean(body.deviceFlowEnabled);
}

describe('GET /api/panel/github-status — deviceFlowEnabled', () => {
  it('is false when a build does not provide a GitHub OAuth client id', async () => {
    delete process.env.GITHUB_OAUTH_CLIENT_ID;
    expect(await readDeviceFlowEnabled()).toBe(false);
  });

  it('is false when GITHUB_OAUTH_CLIENT_ID is blank whitespace', async () => {
    process.env.GITHUB_OAUTH_CLIENT_ID = '   ';
    expect(await readDeviceFlowEnabled()).toBe(false);
  });

  it('is true once GITHUB_OAUTH_CLIENT_ID is configured', async () => {
    process.env.GITHUB_OAUTH_CLIENT_ID = 'Iv1.testclientid';
    expect(await readDeviceFlowEnabled()).toBe(true);
  });
});
