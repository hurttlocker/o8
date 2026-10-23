import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const files = vi.hoisted(() => new Map<string, 'executable' | 'directory' | 'denied'>());
vi.mock('node:fs', () => ({
  constants: { X_OK: 1 },
  statSync: vi.fn((file: string) => ({ isFile: () => files.has(file) && files.get(file) !== 'directory' })),
  accessSync: vi.fn((file: string) => {
    if (files.get(file) !== 'executable') throw new Error('EACCES');
  }),
}));

beforeEach(() => {
  files.clear();
  vi.resetModules();
  vi.stubEnv('PATH', '/fixture/bin');
});
afterEach(() => vi.unstubAllEnvs());

describe.skipIf(process.platform === 'win32')('Git executable discovery', () => {
  it('preserves an executable on the absolute PATH before platform fallbacks', async () => {
    files.set('/fixture/bin/git', 'executable');
    files.set('/usr/bin/git', 'executable');
    const { resolveGitBinary } = await import('./binary');
    expect(resolveGitBinary()).toBe('/fixture/bin/git');
  });

  it('ignores cwd-relative entries and skips directories and non-executable candidates', async () => {
    vi.stubEnv('PATH', ':.:relative:/directory:/denied');
    files.set('relative/git', 'executable');
    files.set('/directory/git', 'directory');
    files.set('/denied/git', 'denied');
    files.set('/usr/bin/git', 'executable');
    const { resolveGitBinary } = await import('./binary');
    expect(resolveGitBinary()).toBe('/usr/bin/git');
  });

  it('tries the supported fallback locations in order without spawning a probe', async () => {
    vi.stubEnv('PATH', '');
    files.set('/usr/bin/git', 'denied');
    files.set('/opt/homebrew/bin/git', 'executable');
    files.set('/usr/local/bin/git', 'executable');
    const { resolveGitBinary } = await import('./binary');
    expect(resolveGitBinary()).toBe('/opt/homebrew/bin/git');
  });

  it('caches discovery for the same environment and resolves a changed PATH again', async () => {
    files.set('/fixture/bin/git', 'executable');
    files.set('/usr/bin/git', 'executable');
    const { resolveGitBinary } = await import('./binary');
    const { statSync } = await import('node:fs');
    expect(resolveGitBinary()).toBe('/fixture/bin/git');
    const probes = vi.mocked(statSync).mock.calls.length;
    expect(resolveGitBinary()).toBe('/fixture/bin/git');
    expect(vi.mocked(statSync).mock.calls.length).toBe(probes);
    vi.stubEnv('PATH', '');
    expect(resolveGitBinary()).toBe('/usr/bin/git');
  });

  it('reports a next step when Git is unavailable and allows retry after installation', async () => {
    const { resolveGitBinary } = await import('./binary');
    expect(() => resolveGitBinary()).toThrow('Install Git or add its executable directory to PATH, then retry.');
    files.set('/usr/local/bin/git', 'executable');
    expect(resolveGitBinary()).toBe('/usr/local/bin/git');
  });
});
