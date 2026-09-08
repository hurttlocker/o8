import * as childProcess from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isGitWorkTreeSync } from '@/lib/lane/repo-preflight';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

const fixtures: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'o8-idle-preflight-'));
  fixtures.push(directory);
  return directory;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('non-repository idle preflight', () => {
  it('spawns nothing for repeated non-repository checks and notices a later git init', () => {
    const directory = fixture();
    const git = vi.mocked(childProcess.execFileSync).mockClear();
    for (let index = 0; index < 10; index += 1) expect(isGitWorkTreeSync(directory)).toBe(false);
    expect(git).not.toHaveBeenCalled();
    childProcess.execFileSync('git', ['init', '--quiet', directory]);
    git.mockClear();
    expect(isGitWorkTreeSync(directory)).toBe(true);
    expect(git).toHaveBeenCalledOnce();
  });

  it('lets Git decide for repository subfolders, symlinks, and separate metadata', () => {
    const directory = fixture();
    const repo = join(directory, 'repo');
    const gitDir = join(directory, 'metadata');
    childProcess.execFileSync('git', ['init', '--quiet', '--separate-git-dir', gitDir, repo]);
    const nested = join(repo, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    const link = join(directory, 'linked');
    symlinkSync(nested, link);
    expect(isGitWorkTreeSync(repo)).toBe(true);
    expect(isGitWorkTreeSync(nested)).toBe(true);
    expect(isGitWorkTreeSync(link)).toBe(true);
  });

  it('does not cache a positive result after metadata is removed', () => {
    const directory = fixture();
    childProcess.execFileSync('git', ['init', '--quiet', directory]);
    expect(isGitWorkTreeSync(directory)).toBe(true);
    rmSync(join(directory, '.git'), { recursive: true });
    const git = vi.mocked(childProcess.execFileSync).mockClear();
    expect(isGitWorkTreeSync(directory)).toBe(false);
    expect(git).not.toHaveBeenCalled();
  });

  it('does not reject an explicit external Git environment before probing it', () => {
    const directory = fixture();
    vi.stubEnv('GIT_DIR', join(directory, 'elsewhere'));
    const git = vi.mocked(childProcess.execFileSync).mockClear().mockReturnValueOnce('true\n');
    expect(isGitWorkTreeSync(directory)).toBe(true);
    expect(git).toHaveBeenCalledOnce();
  });
});
