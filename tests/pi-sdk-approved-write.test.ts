import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync,
  readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildPiWriteHelper } from './helpers/pi-write-helper';

// Direct runs of the native approved-write helper (#3289) through its real
// interface: request on stdin, the parent directory as fd 3, the target as fd 4.
let helper: string;
beforeAll(() => { helper = buildPiWriteHelper(); }, 600_000);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function workspaceFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-pi-write-helper-'))); roots.push(root);
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  return { root, workspace };
}
function request(workspace: string, overrides: Record<string, unknown> = {}) {
  const stat = lstatSync(workspace);
  return { mode: 'commit', root: workspace, parent: { path: workspace, dev: stat.dev, ino: stat.ino,
    root: { dev: stat.dev, ino: stat.ino } }, name: 'note.txt', target: null, before: null, content: 'hello π',
  stage: `.o8-pi-write-${randomUUID()}`, ...overrides };
}
function run(directoryPath: string, body: object | string, target?: string) {
  const directory = openSync(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY);
  const targetFd = target ? openSync(target, constants.O_RDWR) : undefined;
  try {
    const result = spawnSync(helper, [], { cwd: '/', env: { NODE_ENV: 'production' }, timeout: 10_000, encoding: 'utf8',
      input: typeof body === 'string' ? body : JSON.stringify(body),
      stdio: ['pipe', 'pipe', 'pipe', directory, targetFd ?? 'ignore'] });
    return { ...result, reports: result.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)) };
  } finally {
    closeSync(directory);
    if (targetFd !== undefined) closeSync(targetFd);
  }
}
const leftovers = (dir: string) => readdirSync(dir).filter(name => name.startsWith('.o8-pi-'));

describe('native approved write helper boundary', () => {
  it('publishes approved UTF-8 bytes and reports its stage and commit point', () => {
    const { workspace } = workspaceFixture();
    const result = run(workspace, request(workspace));
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    expect(readFileSync(join(workspace, 'note.txt'), 'utf8')).toBe('hello π');
    const published = lstatSync(join(workspace, 'note.txt'));
    expect(result.reports[0]).toEqual({ stage: { dev: published.dev, ino: published.ino } });
    expect(result.reports.at(-1)).toEqual({ committed: true });
    expect(published.nlink).toBe(1);
    expect(leftovers(workspace)).toEqual([]);
  });

  it('replaces the approved target with its mode and removes the replaced file', () => {
    const { workspace } = workspaceFixture();
    const path = join(workspace, 'note.txt');
    writeFileSync(path, 'original'); chmodSync(path, 0o640);
    const original = lstatSync(path);
    const result = run(workspace, request(workspace, { target: { dev: original.dev, ino: original.ino },
      before: Buffer.from('original').toString('base64') }), path);
    expect(result.status).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe('hello π');
    expect(lstatSync(path).ino).not.toBe(original.ino);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(leftovers(workspace)).toEqual([]);
  });

  it.each([
    ['a protected name', { name: '.env' }],
    ['a nested name', { name: 'sub/note.txt' }],
    ['a parent reference', { name: '..' }],
    ['a stage outside the transaction names', { stage: 'note.txt.tmp' }],
    ['content over the size limit', { content: 'x'.repeat(50_001) }],
    ['recovery without a stage identity', { mode: 'recover' }],
    ['a capture outside the transaction names', { mode: 'recover', stageId: { dev: 1, ino: 1 }, captures: [{ name: 'note.txt', from: 'note.txt' }] }],
    ['an unknown mode', { mode: 'delete' }],
  ])('refuses %s without touching the workspace', (_, overrides) => {
    const { workspace } = workspaceFixture();
    const result = run(workspace, request(workspace, overrides));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(readdirSync(workspace)).toEqual([]);
  });

  it('refuses a request that is not JSON', () => {
    const { workspace } = workspaceFixture();
    expect(run(workspace, 'not json').status).toBe(1);
    expect(readdirSync(workspace)).toEqual([]);
  });

  it('refuses when fd 3 is not the approved parent', () => {
    const { root, workspace } = workspaceFixture();
    const other = join(root, 'other'); mkdirSync(other);
    const result = run(other, request(workspace));
    expect(result.status).toBe(1);
    expect(readdirSync(workspace)).toEqual([]);
    expect(readdirSync(other)).toEqual([]);
  });

  it('refuses a target whose bytes differ from the approved snapshot', () => {
    const { workspace } = workspaceFixture();
    const path = join(workspace, 'note.txt');
    writeFileSync(path, 'original');
    const original = lstatSync(path);
    const result = run(workspace, request(workspace, { target: { dev: original.dev, ino: original.ino },
      before: Buffer.from('approved snapshot').toString('base64') }), path);
    expect(result.status).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe('original');
    expect(leftovers(workspace)).toEqual([]);
  });

  it('never overwrites a file that appeared after a new file was approved', () => {
    const { workspace } = workspaceFixture();
    writeFileSync(join(workspace, 'note.txt'), 'appeared');
    expect(run(workspace, request(workspace)).status).toBe(1);
    expect(readFileSync(join(workspace, 'note.txt'), 'utf8')).toBe('appeared');
    expect(existsSync(join(workspace, 'note.txt'))).toBe(true);
    expect(leftovers(workspace)).toEqual([]);
  });
});
