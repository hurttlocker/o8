import { afterEach, describe, expect, it, vi } from 'vitest';

const resolver = vi.hoisted(() => vi.fn());
vi.mock('@/lib/runtimes/shared/cli-resolver', () => ({
  resolveCli: resolver,
  compareCliVersions: (a: string, b: string) => {
    const left = a.split('.').map(Number);
    const right = b.split('.').map(Number);
    for (let index = 0; index < 3; index += 1) {
      if (left[index] !== right[index]) return left[index]! - right[index]!;
    }
    return 0;
  },
}));

import { GET } from './route';

afterEach(() => {
  resolver.mockReset();
  vi.unstubAllGlobals();
});

describe('GET /api/setup/cli-updates', () => {
  it('compares the selected launch binary with a newer package release', async () => {
    resolver.mockImplementation(async ({ runtimeId }: { runtimeId: string }) => {
      if (runtimeId !== 'codex') throw new Error('not installed');
      return { path: '/selected/codex', version: '0.154.0', source: 'env', detectedAt: Date.now() };
    });
    const fetchMock = vi.fn(async () => Response.json({ version: '0.157.1' }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await GET(new Request('http://localhost/api/setup/cli-updates?refresh=1'));
    const report = await response.json();
    expect(response.status).toBe(200);
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ runtimeId: 'codex', envOverride: 'O8_CODEX_BIN' }));
    expect(fetchMock).toHaveBeenCalledWith(
      'https://registry.npmjs.org/%40openai%2Fcodex/latest',
      expect.objectContaining({ cache: 'no-store' }),
    );
    expect(report.tools.find((tool: { runtimeId: string }) => tool.runtimeId === 'codex')).toMatchObject({
      selectedPath: '/selected/codex',
      installedVersion: '0.154.0',
      latestVersion: '0.157.1',
      status: 'update-available',
    });
  });

  it('does not claim an update when the release check fails', async () => {
    resolver.mockImplementation(async ({ runtimeId }: { runtimeId: string }) => {
      if (runtimeId !== 'codex') throw new Error('not installed');
      return { path: '/selected/codex', version: '0.157.1', source: 'which', detectedAt: Date.now() };
    });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));

    const response = await GET(new Request('http://localhost/api/setup/cli-updates?refresh=1'));
    const report = await response.json();
    expect(report.tools.find((tool: { runtimeId: string }) => tool.runtimeId === 'codex').status).toBe('unknown');
  });

  it('checks Antigravity through agy and its own release channel', async () => {
    resolver.mockImplementation(async ({ runtimeId }: { runtimeId: string }) => {
      if (runtimeId !== 'antigravity') throw new Error('not installed');
      return { path: '/selected/agy', version: '1.2.9', source: 'env', detectedAt: Date.now() };
    });
    const fetchMock = vi.fn(async () => Response.json({ tag_name: '1.2.11' }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await GET(new Request('http://localhost/api/setup/cli-updates?refresh=1'));
    const report = await response.json();
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({
      runtimeId: 'antigravity', binaryName: 'agy', envOverride: 'O8_ANTIGRAVITY_BIN',
    }));
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest',
      expect.objectContaining({ cache: 'no-store' }),
    );
    expect(report.tools.find((tool: { runtimeId: string }) => tool.runtimeId === 'antigravity')).toMatchObject({
      selectedPath: '/selected/agy', installedVersion: '1.2.9', latestVersion: '1.2.11',
      status: 'update-available',
    });
  });
});
