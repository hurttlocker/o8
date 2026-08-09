import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.hoisted(() => vi.fn());
const printJsonMock = vi.hoisted(() => vi.fn());

vi.mock('../cli/src/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cli/src/api.js')>();
  return { ...actual, apiFetch: apiFetchMock };
});
vi.mock('../cli/src/config.js', () => ({ resolveConfig: () => ({ apiBase: 'http://127.0.0.1:47120' }) }));
vi.mock('../cli/src/output.js', () => ({
  printHumanHeading: vi.fn(),
  printHumanKv: vi.fn(),
  printJson: printJsonMock,
}));

const { runMcp } = await import('../cli/src/commands/mcp');

describe('o8 mcp install --opencode', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    printJsonMock.mockReset();
  });

  it('registers o8 through the merge-preserving OpenCode setup route', async () => {
    apiFetchMock.mockResolvedValueOnce({
      status: 200,
      data: { ok: true, action: 'installed', installed: ['o8'] },
    });

    await expect(runMcp({ human: false, verbose: false }, 'install', ['--opencode'])).resolves.toBe(0);

    expect(apiFetchMock).toHaveBeenCalledWith(
      { apiBase: 'http://127.0.0.1:47120' },
      '/api/setup/opencode',
      { method: 'POST', body: {} },
    );
    expect(printJsonMock).toHaveBeenCalledWith(expect.objectContaining({
      schema: 'o8/cli/mcp-install/v1',
      target: 'opencode',
    }));
  });
});
