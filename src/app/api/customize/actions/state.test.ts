import { createHash } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '', auth: vi.fn() }));
vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: fixture.auth }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => path.join(fixture.root, 'data'), migrateDataDirOnce: () => {} }));
vi.mock('@/lib/repos/registry', () => ({ findRepoByLocalPath: async (localPath: string) => [path.join(fixture.root, 'repo-one'), path.join(fixture.root, 'repo-two')].includes(localPath) ? { localPath } : null }));
import { GET, POST } from './route';
import { describeActionState } from '@/lib/action-plugins/state-storage';

function request(body?: unknown, signal?: AbortSignal) {
  return new NextRequest('http://localhost/api/customize/actions', body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, signal });
}
async function post(body: unknown, signal?: AbortSignal) { return POST(request(body, signal)); }
function source(name = 'source', state: unknown = { scope: 'source-and-project' }, workspace = 'none') {
  const directory = path.join(fixture.root, name);
  mkdirSync(directory);
  const script = '#!/bin/sh\nset -eu\ncount=0\nif [ -f "$O8_PLUGIN_STATE_DIR/count" ]; then read -r count < "$O8_PLUGIN_STATE_DIR/count"; fi\ncount=$((count + 1))\nprintf "%s\\n" "$count" > "$O8_PLUGIN_STATE_DIR/.count-new"\nmv "$O8_PLUGIN_STATE_DIR/.count-new" "$O8_PLUGIN_STATE_DIR/count"\nprintf "count=%s\\n" "$count"\n';
  writeFileSync(path.join(directory, 'run.sh'), script);
  const manifest = { format: 'o8-actions-v1', id: 'state-check', name: 'State check', version: '1.0.0', description: 'Persist a counter', supportedPlatforms: [process.platform], workspace, ...(state === undefined ? {} : { state }), files: [{ path: 'run.sh', sha256: createHash('sha256').update(script).digest('hex') }], actions: [{ id: 'increment', description: 'Increment', entry: 'run.sh', args: [], timeoutMs: 5000 }] };
  writeFileSync(path.join(directory, 'o8-actions.json'), JSON.stringify(manifest));
  return { directory, manifest };
}
async function reviewLink(directory: string, repo?: string) {
  const response = await post({ action: 'review', directory, ...(repo ? { repo } : {}) });
  expect(response.status, await response.clone().text()).toBe(200);
  const review = (await response.json()).review;
  expect((await post({ action: 'link', directory, expectedRevision: review.revision, ...(repo ? { repo } : {}) })).status).toBe(200);
  return review;
}
function invoke(revision: string, repo?: string) { return post({ action: 'invoke', id: 'state-check', actionId: 'increment', revision, ...(repo ? { repo } : {}) }); }

describe('declared plugin state through the operator route', () => {
  beforeEach(() => {
    fixture.root = realpathSync(mkdtempSync('/tmp/o8-action-state-'));
    mkdirSync(path.join(fixture.root, 'data'));
    fixture.auth.mockReset().mockReturnValue(null);
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(fixture.root, { recursive: true, force: true }); });

  it('provisions on invocation, retains data and receipt scope after restart, disable and same-source update', async () => {
    const { directory, manifest } = source();
    const review = await reviewLink(directory);
    expect(review.execution.environmentKeys).toEqual(['PATH', 'NODE_ENV', 'O8_PLUGIN_STATE_DIR']);
    const state = review.execution.state;
    expect(existsSync(path.dirname(state.directory))).toBe(false);
    const first = (await (await invoke(review.revision)).json()).receipt;
    expect(first).toMatchObject({ status: 'succeeded', stdout: 'count=1\n', state });
    vi.resetModules();
    const restarted = await import('./route');
    const second = await restarted.POST(request({ action: 'invoke', id: manifest.id, actionId: 'increment', revision: review.revision }));
    expect((await second.json()).receipt).toMatchObject({ status: 'succeeded', stdout: 'count=2\n', state });
    expect((await post({ action: 'disable', id: manifest.id, revision: review.revision })).status).toBe(200);
    expect(readFileSync(path.join(state.directory, 'count'), 'utf8')).toBe('2\n');
    expect((await post({ action: 'remove', id: manifest.id, revision: review.revision })).status).toBe(200);
    expect(existsSync(state.directory)).toBe(true);
    expect((await (await GET(request())).json()).receipts[0].state).toEqual(state);
    writeFileSync(path.join(directory, 'o8-actions.json'), JSON.stringify({ ...manifest, version: '1.1.0' }));
    const updated = await reviewLink(directory);
    expect(updated.revision).not.toBe(review.revision);
    expect(updated.execution.state).toEqual(state);
    expect((await (await invoke(updated.revision)).json()).receipt.stdout).toBe('count=3\n');
  });

  it('isolates local source folders and reviewed project scopes', async () => {
    const { directory } = source('one');
    const first = await reviewLink(directory);
    await invoke(first.revision);
    await post({ action: 'remove', id: 'state-check', revision: first.revision });
    const secondSource = source('two');
    const second = await reviewLink(secondSource.directory);
    expect(second.execution.state.namespace).not.toBe(first.execution.state.namespace);
    expect((await (await invoke(second.revision)).json()).receipt.stdout).toBe('count=1\n');
    await post({ action: 'remove', id: 'state-check', revision: second.revision });
    const projectSource = source('project', { scope: 'source-and-project' }, 'registered-project');
    const one = path.join(fixture.root, 'repo-one'); const two = path.join(fixture.root, 'repo-two');
    mkdirSync(one); mkdirSync(two);
    const projectOne = await reviewLink(projectSource.directory, one);
    await invoke(projectOne.revision, one);
    await post({ action: 'remove', id: 'state-check', revision: projectOne.revision });
    const projectTwo = await reviewLink(projectSource.directory, two);
    expect(projectTwo.execution.state.namespace).not.toBe(projectOne.execution.state.namespace);
    expect((await (await invoke(projectTwo.revision, two)).json()).receipt.stdout).toBe('count=1\n');
  });

  it('canonicalizes a GitHub source identity across commits without sharing another package or repository', () => {
    const base = { id: 'state-check', sourceDirectory: '/owned/cache-one', workspaceRoot: null, source: { kind: 'github' as const, repository: 'Owner/Repo', directory: 'package', commit: 'a'.repeat(40) } };
    const state = describeActionState(base);
    expect(describeActionState({ ...base, sourceDirectory: '/owned/cache-two', source: { ...base.source, repository: 'owner/repo', commit: 'b'.repeat(40) } })).toEqual(state);
    for (const source of [{ ...base.source, directory: 'another' }, { ...base.source, repository: 'owner/another' }]) expect(describeActionState({ ...base, source }).namespace).not.toBe(state.namespace);
    expect(existsSync(path.dirname(state.directory))).toBe(false);
  });

  it('does not provision for denied, stale, disabled, wrong-project or pre-cancelled runs', async () => {
    const { directory } = source('project', { scope: 'source-and-project' }, 'registered-project');
    const repo = path.join(fixture.root, 'repo-one'); mkdirSync(repo);
    const review = await reviewLink(directory, repo);
    fixture.auth.mockReturnValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }));
    expect((await invoke(review.revision, repo)).status).toBe(401);
    expect((await invoke('a'.repeat(64), repo)).status).toBe(409);
    expect((await invoke(review.revision)).status).toBe(400);
    const controller = new AbortController(); controller.abort();
    expect((await post({ action: 'invoke', id: 'state-check', actionId: 'increment', revision: review.revision, repo }, controller.signal)).status).toBe(409);
    await post({ action: 'disable', id: 'state-check', revision: review.revision });
    expect((await invoke(review.revision, repo)).status).toBe(409);
    expect(existsSync(path.dirname(review.execution.state.directory))).toBe(false);
    expect((await (await GET(request())).json()).receipts).toEqual([]);
  });

  it('keeps legacy revisions and environment unchanged and migrates old receipts without inventing state', async () => {
    const { directory, manifest } = source();
    const legacy = { ...manifest }; delete (legacy as { state?: unknown }).state;
    const script = '#!/bin/sh\nprintf "state=%s\\n" "${O8_PLUGIN_STATE_DIR-unset}"\n';
    legacy.files[0].sha256 = createHash('sha256').update(script).digest('hex');
    writeFileSync(path.join(directory, 'run.sh'), script);
    writeFileSync(path.join(directory, 'o8-actions.json'), JSON.stringify(legacy));
    const review = await reviewLink(directory);
    expect(review.revision).toBe(createHash('sha256').update(JSON.stringify({ manifest: legacy, workspaceRoot: null, sourceDirectory: directory })).digest('hex'));
    expect(review.execution).toEqual({ cwd: path.join(fixture.root, 'data/customizations/actions/state-check'), environmentKeys: ['PATH', 'NODE_ENV'], principal: 'local-user' });
    vi.stubEnv('O8_PLUGIN_STATE_DIR', '/ambient-must-not-leak');
    expect((await (await invoke(review.revision)).json()).receipt).toMatchObject({ stdout: 'state=unset\n', state: null });
    expect(existsSync(path.join(fixture.root, 'data/customizations/action-state'))).toBe(false);
    expect((await post({ action: 'clear-state', id: 'state-check', revision: review.revision, confirmed: true })).status).toBe(409);
    const database = new Database(path.join(fixture.root, 'data/customizations/actions/receipts.sqlite'));
    database.exec('ALTER TABLE receipts DROP COLUMN state_metadata'); database.close();
    expect((await (await GET(request())).json()).receipts[0].state).toBeNull();
  });

  it('rejects invalid declarations instead of exposing caller-selected paths or environment keys', async () => {
    for (const [index, declaration] of [{ scope: 'global' }, { scope: 'source-and-project', directory: '/tmp/anything' }, { scope: 'source-and-project', environmentKey: 'HOME' }, null].entries()) {
      const { directory } = source(`invalid-${index}`, declaration);
      expect((await post({ action: 'review', directory })).status).toBe(400);
    }
    expect(existsSync(path.join(fixture.root, 'data/customizations/action-state'))).toBe(false);
  });

  it('refuses existing and dangling symlink substitution before writing or clearing saved data', async () => {
    const { directory } = source(); const review = await reviewLink(directory);
    await invoke(review.revision);
    const stateDir = review.execution.state.directory;
    const held = path.join(fixture.root, 'held'); renameSync(stateDir, held);
    for (const target of [held, path.join(fixture.root, 'missing')]) {
      symlinkSync(target, stateDir);
      const failed = await invoke(review.revision);
      expect(failed.status).toBe(400);
      expect((await failed.json()).error.code).toBe('unsafe_state');
      expect((await post({ action: 'clear-state', id: 'state-check', revision: review.revision, confirmed: true })).status).toBe(400);
      expect(readFileSync(path.join(held, 'count'), 'utf8')).toBe('1\n');
      rmSync(stateDir);
    }
  });

  it('refuses linked, changed or public ownership metadata and public state directories', async () => {
    const { directory } = source(); const review = await reviewLink(directory);
    await invoke(review.revision);
    const stateDir = review.execution.state.directory; const metadata = path.join(stateDir, '.scope.json');
    const original = readFileSync(metadata);
    writeFileSync(metadata, '{}'); expect((await invoke(review.revision)).status).toBe(400);
    writeFileSync(metadata, original);
    linkSync(metadata, path.join(fixture.root, 'metadata-link')); expect((await invoke(review.revision)).status).toBe(400);
    rmSync(path.join(fixture.root, 'metadata-link'));
    chmodSync(metadata, 0o644); expect((await invoke(review.revision)).status).toBe(400); chmodSync(metadata, 0o600);
    chmodSync(stateDir, 0o755); expect((await invoke(review.revision)).status).toBe(400);
    expect(readFileSync(path.join(stateDir, 'count'), 'utf8')).toBe('1\n');
  });

  it('requires explicit confirmation and the current revision to clear state, then starts fresh', async () => {
    const { directory } = source(); const review = await reviewLink(directory);
    await invoke(review.revision);
    expect((await post({ action: 'clear-state', id: 'state-check', revision: review.revision })).status).toBe(400);
    expect((await post({ action: 'clear-state', id: 'state-check', revision: 'a'.repeat(64), confirmed: true })).status).toBe(409);
    fixture.auth.mockReturnValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }));
    expect((await post({ action: 'clear-state', id: 'state-check', revision: review.revision, confirmed: true })).status).toBe(401);
    const database = new Database(path.join(fixture.root, 'data/customizations/actions/receipts.sqlite'));
    database.prepare('INSERT INTO receipts (id,plugin_id,action_id,actor,revision,status,started_at) VALUES (?,?,?,?,?,?,?)').run('busy', 'state-check', 'increment', 'local-operator', review.revision, 'running', new Date().toISOString()); database.close();
    expect((await post({ action: 'clear-state', id: 'state-check', revision: review.revision, confirmed: true })).status).toBe(409);
    const settled = new Database(path.join(fixture.root, 'data/customizations/actions/receipts.sqlite')); settled.prepare('DELETE FROM receipts WHERE id=?').run('busy'); settled.close();
    expect((await (await post({ action: 'clear-state', id: 'state-check', revision: review.revision, confirmed: true })).json()).cleared).toBe(true);
    expect(existsSync(review.execution.state.directory)).toBe(false);
    expect((await (await invoke(review.revision)).json()).receipt.stdout).toBe('count=1\n');
    expect((await (await GET(request())).json()).receipts).toHaveLength(2);
  });

  it('runs the author example through the built CLI and real route in two separate host processes', async () => {
    execFileSync(process.execPath, ['cli/esbuild.config.mjs'], { cwd: process.cwd() });
    let child: ChildProcess | undefined;
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_ENV: 'test', O8_DATA_DIR: path.join(fixture.root, 'data'), O8_TEST_FILE_MARKER: process.env.O8_TEST_FILE_MARKER };
    const start = async () => {
      child = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx', './tests/fixtures/action-plugin-state-host.ts'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
      return new Promise<number>((resolve, reject) => {
        let output = ''; let errors = '';
        const timer = setTimeout(() => reject(new Error(`Host did not start: ${errors}`)), 15_000);
        child!.stderr!.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
        child!.stdout!.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          const match = output.match(/\{"port":(\d+)\}/);
          if (match) { clearTimeout(timer); resolve(Number(match[1])); }
        });
        child!.on('error', (error) => { clearTimeout(timer); reject(error); });
        child!.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Host exited ${code}: ${errors}`)); });
      });
    };
    const stop = async () => {
      if (!child || child.exitCode !== null) return;
      const current = child;
      const exited = new Promise<void>((resolve) => current.once('exit', () => resolve()));
      current.kill('SIGTERM');
      const timer = setTimeout(() => current.kill('SIGKILL'), 3000);
      await exited; clearTimeout(timer); child = undefined;
    };
    const cli = (port: number, args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const command = spawn(process.execPath, ['cli/dist/o8.mjs', ...args], { cwd: process.cwd(), env: { ...env, O8_API_PORT: String(port), O8_API_TOKEN: 'fixture-local-operator' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      command.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      command.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      command.on('error', reject); command.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    try {
      let port = await start();
      const reviewed = await cli(port, ['plugin', 'source', 'review', '--directory', path.join(process.cwd(), 'examples/action-plugins/persistent-counter')]);
      expect(reviewed.code, reviewed.stderr).toBe(0);
      const review = JSON.parse(reviewed.stdout).review;
      expect(existsSync(review.execution.state.directory)).toBe(false);
      const linked = await cli(port, ['plugin', 'source', 'link', '--directory', review.sourceDirectory, '--revision', review.revision]);
      expect(linked.code, linked.stderr).toBe(0);
      const args = ['plugin', 'action', 'invoke', 'persistent-counter', 'increment', '--revision', review.revision];
      const first = await cli(port, args); expect(first.code, first.stderr + first.stdout).toBe(0);
      expect(JSON.parse(first.stdout).receipt).toMatchObject({ stdout: 'Counter: 1\n', state: review.execution.state });
      await stop(); port = await start();
      const second = await cli(port, args); expect(second.code, second.stderr + second.stdout).toBe(0);
      expect(JSON.parse(second.stdout).receipt).toMatchObject({ stdout: 'Counter: 2\n', state: review.execution.state });
      const logs = await cli(port, ['plugin', 'log', 'list', '--plugin', 'persistent-counter']);
      expect(logs.code, logs.stderr).toBe(0); expect(JSON.parse(logs.stdout).receipts).toHaveLength(2);
      const cleared = await cli(port, ['plugin', 'state', 'clear', 'persistent-counter', '--revision', review.revision, '--confirm']);
      expect(cleared.code, cleared.stderr).toBe(0); expect(JSON.parse(cleared.stdout).cleared).toBe(true);
      const fresh = await cli(port, args); expect(fresh.code, fresh.stderr).toBe(0); expect(JSON.parse(fresh.stdout).receipt.stdout).toBe('Counter: 1\n');
    } finally { await stop(); }
  }, 45_000);
});
