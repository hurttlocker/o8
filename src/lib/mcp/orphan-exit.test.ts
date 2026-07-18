import { afterEach, describe, expect, it, vi } from 'vitest';

const existsSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: existsSyncMock,
}));

import { exitWhenBundleDeleted, resolveInstalledAppAnchor } from './orphan-exit';

const bundledScript = '/Applications/o8.app/Contents/Resources/server/operator-mcp-server.mjs';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  existsSyncMock.mockReset();
  vi.restoreAllMocks();
});

describe('resolveInstalledAppAnchor', () => {
  it('derives the app root from the explicit bundled MCP path', () => {
    expect(resolveInstalledAppAnchor('/tmp/operator-mcp-server.mjs', {
      O8_BUNDLED_MCP_PATH: bundledScript,
    })).toBe('/Applications/o8.app');
  });

  it('derives the app root from the explicit bundled MCP directory', () => {
    expect(resolveInstalledAppAnchor('/tmp/cortex-mcp-server.mjs', {
      O8_BUNDLED_MCP_DIR: '/Applications/o8.app/Contents/Resources/server',
    })).toBe('/Applications/o8.app');
  });

  it('derives the app root from a bundled script path without env hints', () => {
    expect(resolveInstalledAppAnchor(bundledScript, {})).toBe('/Applications/o8.app');
  });

  it('returns null for source-launched and lookalike paths', () => {
    expect(resolveInstalledAppAnchor('/repo/src/lib/mcp/operator-mcp-server.ts', {})).toBeNull();
    expect(resolveInstalledAppAnchor('/repo/src/lib/mcp/operator-mcp-server.ts', {
      O8_BUNDLED_MCP_PATH: bundledScript,
    })).toBeNull();
    expect(resolveInstalledAppAnchor('/Applications/not-o8.app/Contents/Resources/server/operator.mjs', {})).toBeNull();
    expect(resolveInstalledAppAnchor('/Applications/o8.app-backup/Contents/Resources/server/operator.mjs', {})).toBeNull();
    expect(resolveInstalledAppAnchor('/repo/operator.ts', { O8_BUNDLED_MCP_PATH: '/tmp/server/operator.mjs' })).toBeNull();
  });
});

describe('exitWhenBundleDeleted', () => {
  it('checks at startup and exits immediately when the installed app is gone', () => {
    existsSyncMock.mockReturnValue(false);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    exitWhenBundleDeleted('test', bundledScript, {});

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(stderrSpy).toHaveBeenCalledOnce();
  });

  it('polls the installed app anchor and exits once when it disappears', () => {
    vi.useFakeTimers();
    existsSyncMock.mockReturnValue(true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    exitWhenBundleDeleted('test', bundledScript, {});
    vi.advanceTimersByTime(60_000);
    expect(exitSpy).not.toHaveBeenCalled();

    existsSyncMock.mockReturnValue(false);
    vi.advanceTimersByTime(60_000);
    vi.advanceTimersByTime(60_000);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it('never arms or exits for a source-launched dev server', () => {
    vi.useFakeTimers();
    existsSyncMock.mockReturnValue(false);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    exitWhenBundleDeleted('test', '/repo/src/lib/mcp/operator-mcp-server.ts', {});
    vi.advanceTimersByTime(180_000);

    expect(existsSyncMock).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
