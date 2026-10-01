import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { resolvePublishedCloudBase } from '@/lib/cloud/published-base';

const root = mkdtempSync(join(tmpdir(), 'o8-cloud-published-base-'));
const repo = join(root, 'repo');
const remote = join(root, 'remote.git');
const git = (...args: string[]) => execFileSync('git', args, { stdio: 'pipe' }).toString().trim();
afterAll(() => rmSync(root, { recursive: true, force: true }));

it('pins the published branch despite an unpushed local merge and refuses an unpublished revision', async () => {
  git('init', '-b', 'main', repo);
  git('-C', repo, 'config', 'user.name', 'Fixture');
  git('-C', repo, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(repo, 'README.md'), 'Published\n');
  git('-C', repo, 'add', 'README.md');
  git('-C', repo, 'commit', '-m', 'test: published');
  const published = git('-C', repo, 'rev-parse', 'HEAD');
  git('init', '--bare', remote);
  git('-C', repo, 'remote', 'add', 'origin', remote);
  git('-C', repo, 'push', 'origin', 'main');
  writeFileSync(join(repo, 'README.md'), 'Unpublished local work\n');
  git('-C', repo, 'commit', '-am', 'test: unpublished');
  const local = git('-C', repo, 'rev-parse', 'HEAD');
  expect(local).not.toBe(published);
  expect(await resolvePublishedCloudBase(repo, 'main')).toBe(published);
  await expect(resolvePublishedCloudBase(repo, local)).rejects.toThrow('Remote base is unavailable');
  expect(git('-C', repo, 'rev-parse', 'HEAD')).toBe(local);
  git('-C', repo, 'remote', 'set-url', 'origin', join(root, 'missing.git'));
  await expect(resolvePublishedCloudBase(repo, 'main')).rejects.toThrow('Remote base is unavailable');
});
