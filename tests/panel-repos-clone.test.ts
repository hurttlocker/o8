import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Real-path test for the repos `clone` action (#1339 / #1334).
 *
 * Onboarding's "Continue with N repos" posts { action:'clone', cloneUrl } to
 * POST /api/panel/repos. Per the reachability rule this drives the ACTUAL
 * route handler (not cloneRepoToDefaultLocation in isolation) against a local
 * `git clone --bare` fixture (offline), with HOME redirected to a tmp dir so
 * the registry (~/.o8/repos.json) and the clone destination (~/Developer) are
 * both isolated — and asserts the repo really lands on disk AND in the registry.
 */

const REAL_HOME = process.env.HOME;
const REAL_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR;
const REAL_O8_DATA_DIR = process.env.O8_DATA_DIR;
// Set process-wide path overrides before importing the real route. Modules
// intentionally bind their store paths once at server startup.
const tmpHome = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-clone-test-')));
process.env.HOME = tmpHome;
process.env.CORTEX_IDE_DATA_DIR = path.join(tmpHome, '.o8-data');
process.env.O8_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR;
mkdirSync(process.env.CORTEX_IDE_DATA_DIR, { recursive: true });
let fixtureBare: string;

function git(args: string[], cwd: string) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

beforeAll(() => {
  // Build a real repo with one commit, then a bare mirror to clone from.
  const src = path.join(tmpHome, 'fixture-src');
  mkdirSync(src, { recursive: true });
  git(['init', '--initial-branch=main'], src);
  writeFileSync(path.join(src, 'README.md'), '# clone fixture\n');
  git(['add', 'README.md'], src);
  git(['-c', 'user.email=test@o8.local', '-c', 'user.name=o8-test', 'commit', '-m', 'init'], src);
  fixtureBare = path.join(tmpHome, 'fixture.git');
  git(['clone', '--bare', src, fixtureBare], tmpHome);
});

afterAll(() => {
  if (REAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = REAL_HOME;
  if (REAL_DATA_DIR === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = REAL_DATA_DIR;
  if (REAL_O8_DATA_DIR === undefined) delete process.env.O8_DATA_DIR;
  else process.env.O8_DATA_DIR = REAL_O8_DATA_DIR;
});

async function postRepos(body: unknown) {
  const { POST } = await import('@/app/api/panel/repos/route');
  return POST(new Request('http://127.0.0.1/api/panel/repos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

describe('POST /api/panel/repos action=clone (real route handler)', () => {
  it('clones the repo under ~/Developer and registers it in the registry', async () => {
    const res = await postRepos({ action: 'clone', cloneUrl: fixtureBare, name: 'clone-fixture' });
    const data = await res.json() as { error?: string; repo?: { localPath: string; name: string } };

    expect(res.status, data.error).toBe(201);
    expect(data.repo).toBeTruthy();
    const localPath = data.repo!.localPath;
    expect(localPath).toBe(path.join(tmpHome, 'Developer', 'clone-fixture'));
    // Actually on disk, actually a git repo with the fixture content.
    expect(existsSync(path.join(localPath, '.git'))).toBe(true);
    expect(existsSync(path.join(localPath, 'README.md'))).toBe(true);
    // Actually in the persisted registry under the isolated data directory.
    const store = JSON.parse(readFileSync(path.join(process.env.CORTEX_IDE_DATA_DIR!, 'repos.json'), 'utf-8')) as { repos: Array<{ localPath: string }> };
    expect(store.repos.some(r => r.localPath === localPath)).toBe(true);
  }, 60_000);

  it('is idempotent — re-cloning the same repo re-registers the existing checkout', async () => {
    const res = await postRepos({ action: 'clone', cloneUrl: fixtureBare, name: 'clone-fixture' });
    const data = await res.json() as { repo?: { localPath: string } };
    expect(res.status).toBe(201);
    expect(data.repo?.localPath).toBe(path.join(tmpHome, 'Developer', 'clone-fixture'));
  }, 60_000);

  it('rejects a missing cloneUrl', async () => {
    const res = await postRepos({ action: 'clone', cloneUrl: '' });
    expect(res.status).toBe(400);
  });

  it('rejects a cloneUrl that would be parsed as a git option', async () => {
    const res = await postRepos({ action: 'clone', cloneUrl: '--upload-pack=/bin/false' });
    const data = await res.json() as { error?: string };
    expect(res.status).toBe(400);
    expect(data.error).toBe('Invalid cloneUrl.');
  });
});
