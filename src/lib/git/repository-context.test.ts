import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({ lstat: vi.fn(), realpath: vi.fn() }));

import { mayHaveGitRepositoryContext } from './repository-context';

const resolved = path.resolve('fixture-context', 'nested');
const absent = Object.assign(new Error('absent'), { code: 'ENOENT' });
const present = {} as Awaited<ReturnType<typeof lstat>>;

beforeEach(() => {
  vi.stubEnv('GIT_DIR', '');
  vi.stubEnv('GIT_WORK_TREE', '');
  vi.mocked(realpath).mockReset().mockResolvedValue(resolved);
  vi.mocked(lstat).mockReset().mockRejectedValue(absent);
});

afterEach(() => vi.unstubAllEnvs());

describe('repository context hints', () => {
  it('proves an ordinary folder has no context without inspecting its contents', async () => {
    expect(await mayHaveGitRepositoryContext('input')).toBe(false);
    expect(vi.mocked(lstat).mock.calls.every(([file]) => (
      ['.git', 'HEAD'].includes(path.basename(String(file)))
    ))).toBe(true);
  });

  it('accepts an ancestor marker after resolving the physical folder', async () => {
    vi.mocked(lstat).mockImplementation(async (file) => {
      if (file === path.join(path.dirname(resolved), '.git')) return present;
      throw absent;
    });
    expect(await mayHaveGitRepositoryContext('input')).toBe(true);
    expect(realpath).toHaveBeenCalledWith(path.resolve('input'));
  });

  it('lets Git validate pointer files, symlinks, and other positive markers', async () => {
    vi.mocked(lstat).mockResolvedValueOnce(present);
    expect(await mayHaveGitRepositoryContext('input')).toBe(true);
  });

  it('retains the bare-repository HEAD hint', async () => {
    vi.mocked(lstat).mockImplementation(async (file) => {
      if (file === path.join(resolved, 'HEAD')) return present;
      throw absent;
    });
    expect(await mayHaveGitRepositoryContext('input')).toBe(true);
  });

  it('rechecks absence so later initialization is not hidden', async () => {
    expect(await mayHaveGitRepositoryContext('input')).toBe(false);
    vi.mocked(lstat).mockResolvedValueOnce(present);
    expect(await mayHaveGitRepositoryContext('input')).toBe(true);
  });

  it.each(['GIT_DIR', 'GIT_WORK_TREE'])('retains the normal path for %s overrides', async (key) => {
    vi.stubEnv(key, 'explicit-context');
    expect(await mayHaveGitRepositoryContext('input')).toBe(true);
    expect(realpath).not.toHaveBeenCalled();
    expect(lstat).not.toHaveBeenCalled();
  });

  it('does not confuse permission or I/O failures with absence', async () => {
    vi.mocked(lstat).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    expect(await mayHaveGitRepositoryContext('input')).toBe(true);
  });

  it('keeps discovery when the physical folder cannot be resolved', async () => {
    vi.mocked(realpath).mockRejectedValueOnce(absent);
    expect(await mayHaveGitRepositoryContext('input')).toBe(true);
    expect(lstat).not.toHaveBeenCalled();
  });

  it('bounds ancestor checks and leaves unusually deep paths to Git', async () => {
    vi.mocked(realpath).mockResolvedValue(path.resolve(...Array<string>(140).fill('nested')));
    expect(await mayHaveGitRepositoryContext('input')).toBe(true);
    expect(lstat).toHaveBeenCalledTimes(256);
  });
});
