import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '', auth: vi.fn() }));
vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: fixture.auth }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => path.join(fixture.root, 'data'), migrateDataDirOnce: () => {} }));
vi.mock('@/lib/repos/registry', () => ({ findRepoByLocalPath: async () => null }));
import { GET, POST } from './route';

function request(body?: unknown) {
  return new NextRequest('http://localhost/api/customize/actions', body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
}
async function post(body: unknown, status = 200) {
  const response = await POST(request(body));
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(status);
  return result;
}
let server: string;
function tmux(...args: string[]) { return execFileSync('tmux', ['-L', server, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }); }
async function waitForText(session: string, text: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (tmux('capture-pane', '-p', '-S', '-', '-t', session).includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Missing terminal output: ${text}`);
}
function source() {
  const directory = path.join(fixture.root, 'source'); mkdirSync(directory);
  const script = '#!/bin/sh\nset -eu\nprintf "started\\n" >> "$O8_PLUGIN_STATE_DIR/starts"\nprintf "READY:%s\\n" "$@"\nwhile IFS= read -r line; do printf "REPLY:%s\\n" "$line"; done\n';
  writeFileSync(path.join(directory, 'interactive.sh'), script);
  const manifest = { format: 'o8-actions-v1', id: 'interactive-example', name: 'Interactive example', version: '1.0.0', description: 'A persistent interactive example', supportedPlatforms: [process.platform], workspace: 'none', state: { scope: 'source-and-project' }, files: [{ path: 'interactive.sh', sha256: createHash('sha256').update(script).digest('hex') }], actions: [], terminals: [{ id: 'console', description: 'Interactive console', entry: 'interactive.sh', args: ['a quoted argument; not a command', ';', 'kill-server', "single ' quote $(false)"] }] };
  writeFileSync(path.join(directory, 'o8-actions.json'), JSON.stringify(manifest));
  return directory;
}

describe.skipIf(process.platform === 'win32')('reviewed plugin terminals through the actual route and persistent session', () => {
  beforeEach(() => {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    fixture.root = realpathSync(mkdtempSync('/tmp/o8-plugin-terminals-'));
    mkdirSync(path.join(fixture.root, 'data'));
    server = `o8-plugin-test-${randomUUID()}`;
    vi.stubEnv('O8_DASH_TMUX_SERVER_NAME', server);
    vi.stubEnv('O8_PERSISTENT_TERMINALS', '1');
    fixture.auth.mockReset().mockReturnValue(null);
  });
  afterEach(() => {
    try { tmux('kill-server'); } catch { /* no session was launched */ }
    vi.unstubAllEnvs(); rmSync(fixture.root, { recursive: true, force: true });
  });

  it('launches fixed arguments once, retains input after host reload, and stops with a durable receipt', async () => {
    const directory = source();
    const review = (await post({ action: 'review', directory })).review;
    await post({ action: 'link', directory, expectedRevision: review.revision });
    const launch = { action: 'launch-terminal', id: 'interactive-example', terminalId: 'console', revision: review.revision, requestId: randomUUID() };
    tmux('new-session', '-d', '-s', 'unrelated-sentinel', '/bin/sh');
    const first = (await post(launch)).terminal;
    expect(first.status).toBe('running');
    await waitForText(first.sessionName, 'READY:a quoted argument; not a command');
    await waitForText(first.sessionName, 'READY:;');
    await waitForText(first.sessionName, 'READY:kill-server');
    await waitForText(first.sessionName, "READY:single ' quote $(false)");
    expect(tmux('has-session', '-t', 'unrelated-sentinel')).toBe('');
    tmux('send-keys', '-t', first.sessionName, '-l', 'hello'); tmux('send-keys', '-t', first.sessionName, 'Enter');
    await waitForText(first.sessionName, 'REPLY:hello');
    expect((await post({ ...launch, requestId: launch.requestId.toUpperCase() })).terminal.id).toBe(first.id);
    vi.resetModules();
    const restarted = await import('./route');
    const replay = await restarted.POST(request(launch));
    expect(replay.status).toBe(200);
    expect((await replay.json()).terminal.sessionName).toBe(first.sessionName);
    expect(readFileSync(path.join(first.state.directory, 'starts'), 'utf8')).toBe('started\n');
    await post({ action: 'clear-state', id: launch.id, revision: review.revision, confirmed: true }, 409);
    await post({ action: 'remove', id: launch.id, revision: review.revision }, 409);
    const stopped = (await post({ action: 'stop-terminal', receiptId: first.id })).terminal;
    expect(stopped.status).toBe('stopped');
    expect(() => tmux('has-session', '-t', first.sessionName)).toThrow();
    expect((await post(launch)).terminal.status).toBe('stopped');
    const inventory = await (await GET(request())).json();
    expect(inventory.terminals.find((item: { id: string }) => item.id === first.id)).toMatchObject({ status: 'stopped', revision: review.revision });
    await post({ action: 'clear-state', id: launch.id, revision: review.revision, confirmed: true });
  });

  it('refuses denied, stale, disabled, changed-file and persistence-disabled launches', async () => {
    const directory = source();
    const review = (await post({ action: 'review', directory })).review;
    await post({ action: 'link', directory, expectedRevision: review.revision });
    const launch = { action: 'launch-terminal', id: 'interactive-example', terminalId: 'console', revision: review.revision, requestId: randomUUID() };
    fixture.auth.mockReturnValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }));
    await post(launch, 401);
    await post({ ...launch, revision: 'a'.repeat(64) }, 409);
    await post({ ...launch, repo: path.join(fixture.root, 'unregistered') }, 403);
    await post({ action: 'disable', id: launch.id, revision: launch.revision });
    await post(launch, 409);
    await post({ action: 'enable', id: launch.id, revision: launch.revision });
    vi.stubEnv('O8_PERSISTENT_TERMINALS', '0');
    await post(launch, 409);
    vi.stubEnv('O8_PERSISTENT_TERMINALS', '1');
    writeFileSync(path.join(fixture.root, 'data/customizations/actions/interactive-example/interactive.sh'), '#!/bin/sh\nexit 0\n');
    await post(launch, 409);
    expect(() => tmux('list-sessions')).toThrow();
  });

  it('refuses an unavailable terminal runtime before claiming a launch or creating saved data', async () => {
    const directory = source();
    const review = (await post({ action: 'review', directory })).review;
    await post({ action: 'link', directory, expectedRevision: review.revision });
    const unavailable = path.join(fixture.root, 'unavailable-tmux');
    writeFileSync(unavailable, 'not executable', { mode: 0o600 });
    vi.stubEnv('TMUX_BIN', unavailable);
    await post({ action: 'launch-terminal', id: 'interactive-example', terminalId: 'console', revision: review.revision, requestId: randomUUID() }, 503);
    expect((await (await GET(request())).json()).terminals).toEqual([]);
    expect(() => readFileSync(path.join(review.execution.state.directory, 'starts'))).toThrow();
    await post({ action: 'remove', id: 'interactive-example', revision: review.revision });
  });
});
