/**
 * #3414: the merge gate's lint and test replay run lane code (the lane's
 * ESLint config and its `test` script). Both run through the real
 * `runLaneRebaseVerify` entry under the confinement lane commands get (#3412):
 * writes only inside the lane checkout and a private temp dir. Where
 * confinement is unavailable they still run, and the merge card says so.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildPiWriteHelper } from './helpers/pi-write-helper';

vi.mock('@/lib/operator/defaults', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/operator/defaults')>(),
  resolveMergeTestReplayEnabledSync: () => true,
}));

// Makes command confinement unavailable, as on Windows or a kernel without Landlock.
const confinement = vi.hoisted(() => ({ unavailable: false }));
vi.mock('@/lib/sandbox/confine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sandbox/confine')>();
  return { ...actual, confinementArgs: async (...args: Parameters<typeof actual.confinementArgs>) => {
    if (confinement.unavailable) throw new actual.ConfinementUnavailable();
    return actual.confinementArgs(...args);
  } };
});

const { runLaneRebaseVerify } = await import('@/lib/lane/rebase-verify');
const { UNCONFINED_LINT_NOTE } = await import('@/lib/lane/rebase-lint');
const { UNCONFINED_TESTS_NOTE } = await import('@/lib/lane/rebase-tests');

const confinable = process.platform === 'darwin' || process.platform === 'linux';
const dirs: string[] = [];

function makeDir(label: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `o8-confined-verify-${label}-`)));
  dirs.push(dir);
  return dir;
}

// Unix socket paths are limited to about 104 bytes, so sockets live under /tmp.
function makeShortDir(): string {
  const dir = realpathSync(mkdtempSync('/tmp/o8-sock-'));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', ...args], { cwd, stdio: 'ignore' });
}

// The lane's ESLint config and test script each record one file inside the
// checkout and try to record one outside it. The test script also tries the
// Unix socket at `socket`, as a host control socket would be reached.
function makeLane(outside: string, testExit = 0, socket = join(outside, 'none.sock')): string {
  const repo = makeDir('lane');
  git(repo, ['init', '-b', 'main']);
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n*.ran\n');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({
    private: true,
    scripts: { lint: 'eslint .', test: 'node replay.cjs' },
    devDependencies: { eslint: '^9.39.5' },
  }));
  const record = (name: string) => [
    `require('node:fs').writeFileSync(${JSON.stringify(join(repo, `${name}.ran`))}, '1');`,
    `try { require('node:fs').writeFileSync(${JSON.stringify(join(outside, name))}, '1'); } catch {}`,
  ].join('\n');
  writeFileSync(join(repo, 'eslint.config.cjs'), `${record('lint')}\nmodule.exports = [{ files: ['**/*.js'], rules: {} }];\n`);
  writeFileSync(join(repo, 'replay.cjs'), [
    record('tests'),
    `const socket = require('node:net').connect(${JSON.stringify(socket)});`,
    `socket.on('connect', () => { socket.end(); process.exit(${testExit}); });`,
    `socket.on('error', () => process.exit(${testExit}));`,
  ].join('\n'));
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'index.js'), 'export const base = 1;\n');
  symlinkSync(join(process.cwd(), 'node_modules'), join(repo, 'node_modules'), 'junction');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'base']);
  git(repo, ['checkout', '-b', 'packet/confined']);
  writeFileSync(join(repo, 'src', 'index.js'), 'export const base = 1;\nexport const packet = 2;\n');
  git(repo, ['commit', '-am', 'packet change']);
  return repo;
}

// A Unix socket outside the lane that counts the connections it receives.
async function listenSocket(dir: string): Promise<{ server: Server; path: string; connections: () => number }> {
  const path = join(dir, 'host.sock');
  let count = 0;
  const server = createServer((connection) => { count += 1; connection.end(); });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { server, path, connections: () => count };
}

const verify = (cwd: string) => runLaneRebaseVerify({ cwd, baseRef: 'main', actualBranch: 'packet/confined', logPrefix: 'test' });

beforeAll(() => { if (process.platform === 'linux') buildPiWriteHelper(); }, 600_000);

afterEach(() => {
  confinement.unavailable = false;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('merge-gate lint and test replay confinement (#3414)', () => {
  it.runIf(confinable)('runs the lane lint config and test script confined to the lane checkout', async () => {
    const outside = makeDir('outside');
    const host = await listenSocket(makeShortDir());
    const lane = makeLane(outside, 0, host.path);

    const result = await verify(lane);
    host.server.close();

    expect(result.ok).toBe(true);
    expect(result.checks.find((check) => check.name === 'lint')).toEqual({ name: 'lint', verdict: 'pass' });
    // macOS denies every socket, Unix included. Landlock does not scope
    // pathname Unix sockets, so Linux keeps that residual (#3412).
    if (process.platform === 'darwin') expect(host.connections()).toBe(0);
    // Both ran, and both kept their writes inside the checkout.
    expect(existsSync(join(lane, 'lint.ran'))).toBe(true);
    expect(existsSync(join(lane, 'tests.ran'))).toBe(true);
    expect(existsSync(join(outside, 'lint'))).toBe(false);
    expect(existsSync(join(outside, 'tests'))).toBe(false);
  }, 120_000);

  it('still runs lint and tests where confinement is unavailable, and the merge card says so', async () => {
    confinement.unavailable = true;
    const outside = makeDir('outside');
    const host = await listenSocket(makeShortDir());
    const lane = makeLane(outside, 0, host.path);

    const result = await verify(lane);
    host.server.close();

    expect(result.ok).toBe(true);
    expect(host.connections()).toBe(1);
    const lint = result.checks.find((check) => check.name === 'lint');
    expect(lint?.verdict).toBe('pass');
    expect(lint?.detail).toContain(UNCONFINED_LINT_NOTE);
    expect(lint?.detail).toContain(UNCONFINED_TESTS_NOTE);
    expect(existsSync(join(outside, 'lint'))).toBe(true);
    expect(existsSync(join(outside, 'tests'))).toBe(true);
  }, 120_000);

  it('says an unconfined test failure ran without the sandbox', async () => {
    confinement.unavailable = true;
    const lane = makeLane(makeDir('outside'), 1);

    const result = await verify(lane);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('tests');
    expect(result.output).toContain(UNCONFINED_TESTS_NOTE);
  }, 120_000);
});
