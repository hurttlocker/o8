import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

const authFixture = vi.hoisted(() => ({ home: '' }));
const scanAndLinkMock = vi.hoisted(() => vi.fn((binaryName: string) => (
  binaryName === 'opencode' ? '/test-bin/opencode' : null
)));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    default: {
      ...actual,
      homedir: () => authFixture.home,
    },
  };
});

vi.mock('./cli-locate', () => ({
  scanAndLink: scanAndLinkMock,
}));

authFixture.home = mkdtempSync(path.join(os.tmpdir(), 'o8-opencode-auth-'));

const { getRuntimeAuthSnapshot, invalidateRuntimeAuthCache } = await import('./auth-detect');

afterAll(() => {
  rmSync(authFixture.home, { recursive: true, force: true });
});

describe('OpenCode auth preflight', () => {
  it('reports the missing auth.json path without throwing', async () => {
    invalidateRuntimeAuthCache();
    const snapshot = await getRuntimeAuthSnapshot();
    const status = snapshot.statuses.opencode;

    expect(status).toMatchObject({
      installed: true,
      authenticated: false,
      runtime: 'opencode',
    });
    expect(status.detail).toBe(
      `opencode needs auth.json at ${path.join(authFixture.home, '.local', 'share', 'opencode', 'auth.json')}.`,
    );
    expect(status.fix).toContain('opencode auth login');
  });
});
