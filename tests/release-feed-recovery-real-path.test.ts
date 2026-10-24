import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('recovers only public feed metadata through the real sync script and local Git remote', () => {
  const root = mkdtempSync(join(tmpdir(), 'o8-feed-recovery-'));
  roots.push(root);
  const source = join(root, 'source');
  const mirror = join(root, 'mirror');
  const remote = join(root, 'remote.git');
  const bin = join(root, 'bin');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  for (const repo of [source, mirror]) {
    mkdirSync(repo);
    git(repo, 'init', '-qb', 'main');
    git(repo, 'config', 'user.name', 'fixture');
    git(repo, 'config', 'user.email', 'fixture@example.invalid');
  }
  mkdirSync(join(source, 'scripts/lib'), { recursive: true });
  for (const script of ['sync-public-changelog.sh', 'lib/contributor-credits.mjs', 'lib/merge-public-changelog.mjs']) {
    cpSync(join(process.cwd(), 'scripts', script), join(source, 'scripts', script));
  }
  git(source, 'add', 'scripts');
  git(source, 'commit', '-qm', 'feat: clearer workspace feedback');
  const assets = ['installer.dmg', 'app.tar.gz', 'app.tar.gz.sig', 'latest.json'];
  for (const name of assets) writeFileSync(join(mirror, name), `original ${name}\n`);
  writeFileSync(join(mirror, 'CHANGELOG.md'), '# Changelog\n');
  writeFileSync(join(mirror, 'latest-ship.json'), '{"version":"old"}\n');
  git(mirror, 'add', '.');
  git(mirror, 'commit', '-qm', 'fixture assets');
  git(root, 'clone', '--bare', mirror, remote);
  const before = git(remote, 'rev-parse', 'main');
  mkdirSync(bin);
  // Only the repository clone is brokered. Every other remote operation fails.
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] !== 'repo' || args[1] !== 'clone') process.exit(91);
execFileSync('git', ['clone', '--branch', 'main', process.env.FIXTURE_FEED_REMOTE, args[3]], { stdio: 'pipe' });
`, { mode: 0o755 });
  const metadata = '{"version":"0.1.999","summary":"Clearer workspace feedback."}\n';
  const metadataPath = join(root, 'latest-ship.json');
  writeFileSync(metadataPath, metadata);
  const result = spawnSync('bash', [join(source, 'scripts/sync-public-changelog.sh'), '--latest-ship', metadataPath], {
    cwd: source, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, O8_CHANGELOG_SOURCE_REF: 'HEAD',
      WORK_DIR: root, FIXTURE_FEED_REMOTE: remote, GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(git(remote, 'show', 'main:latest-ship.json')).toBe(metadata.trim());
  expect(git(remote, 'diff', '--name-only', before, 'main').split('\n').sort())
    .toEqual(['CHANGELOG.md', 'STATS.md', 'latest-ship.json']);
  for (const name of assets) {
    expect(git(remote, 'show', `main:${name}`)).toBe(readFileSync(join(mirror, name), 'utf8').trim());
  }
});
