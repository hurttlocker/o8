import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ home: '', selected: '', publish: vi.fn(async () => true), drain: vi.fn(() => ({ draining: true })) }));
const root = mkdtempSync(join(tmpdir(), 'o8-installer-restart-'));
const dataDir = join(root, 'data');
fixture.home = join(root, 'home');
fixture.selected = join(fixture.home, '.o8/bin/claude');
vi.stubEnv('O8_DATA_DIR', dataDir);
vi.stubEnv('CORTEX_IDE_DATA_DIR', dataDir);
vi.stubEnv('CLAUDE_CONFIG_DIR', join(fixture.home, '.claude'));
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, 'ws-token'), 'installer-fixture-operator');
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => fixture.home }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: fixture.publish }));
vi.mock('@/lib/cloud/job-queue', () => ({ beginJobDrain: fixture.drain }));
vi.mock('@/lib/app-update/idle-window', () => ({ getUpdateIdleWindow: async () => ({ idle: true, idleExceptParked: true, parkedLanes: [], unavailable: [],
  active: { lanes: [], ownedSessions: [], managedRuns: [], terminalSessions: [], cloudJobs: [] } }) }));
vi.mock('@/lib/runtimes/shared/cli-resolver', async original => ({
  ...await original<typeof import('@/lib/runtimes/shared/cli-resolver')>(),
  invalidateCliCache: vi.fn(),
  resolveCli: async () => ({ path: fixture.selected, source: 'which',
    version: execFileSync(fixture.selected, ['--version'], { encoding: 'utf8' }).trim() }),
}));
const updates = await import('@/app/api/setup/cli-updates/route');
const relaunch = await import('@/app/api/panel/app/relaunch/route');
const apply = await import('@/app/api/panel/update/apply/route');
const { setAppUpdateState } = await import('@/lib/app-update/relaunch-state');
const { inspectCliOperationAdmission, reserveCliInstaller, releaseOwnedCliUpdateLock } = await import('@/lib/setup/cli-operation-admission');
const reservationPath = join(dataDir, 'cli-operation-admission');
const lockPath = join(dataDir, 'claude-code-cli-update.lock');
const receipt = () => JSON.parse(readFileSync(join(dataDir, 'claude-code-cli-update.json'), 'utf8'));
const request = (path: string, body: unknown = {}) => new Request(`http://localhost${path}`, { method: 'POST',
  headers: { Authorization: 'Bearer installer-fixture-operator', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  rmSync(fixture.home, { recursive: true, force: true });
  for (const name of readdirSync(dataDir)) if (name !== 'ws-token') rmSync(join(dataDir, name), { recursive: true, force: true });
  for (const name of ['started', 'release']) rmSync(join(root, name), { force: true });
  fixture.publish.mockClear(); fixture.drain.mockClear();
  setAppUpdateState({ updatePending: true, version: '0.1.999' });
  const versions = join(fixture.home, '.local/share/claude/versions');
  const launcher = join(fixture.home, '.local/bin/claude');
  mkdirSync(versions, { recursive: true }); mkdirSync(join(fixture.home, '.local/bin'), { recursive: true });
  mkdirSync(join(fixture.home, '.o8/bin'), { recursive: true });
  mkdirSync(join(fixture.home, '.claude'), { recursive: true });
  writeFileSync(join(fixture.home, '.claude/settings.json'), '{"autoUpdatesChannel":"stable"}');
  const executable = join(versions, '2.0.1');
  writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('2.0.1'); process.exit(0); }
if (process.argv[2] !== 'update') process.exit(42);
fs.writeFileSync(${JSON.stringify(join(root, 'started'))}, String(process.pid));
const timer = setInterval(() => {
 if (!fs.existsSync(${JSON.stringify(join(root, 'release'))})) return;
 clearInterval(timer);
 const next = ${JSON.stringify(join(versions, '2.0.2'))};
 fs.writeFileSync(next, ${JSON.stringify(`#!${process.execPath}\nconsole.log('2.0.2');\n`)}, {mode: 0o700});
 fs.unlinkSync(${JSON.stringify(launcher)}); fs.symlinkSync(next, ${JSON.stringify(launcher)});
}, 10);
`);
  chmodSync(executable, 0o700); symlinkSync(executable, launcher); symlinkSync(launcher, fixture.selected);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('2.0.2')));
});
afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); });

it('defers another client restart and forced apply while an executable installer owns admission, then releases after verification', async () => {
  const pending = updates.POST(request('/api/setup/cli-updates', { runtime: 'claude-code' }));
  let installation: Response;
  try {
    await vi.waitFor(() => expect(existsSync(join(root, 'started'))).toBe(true));
    expect(receipt()).toMatchObject({ status: 'installing', selectedPath: fixture.selected });
    const restart = await relaunch.POST(request('/api/panel/app/relaunch'));
    const restartPayload = await restart.json();
    expect(restart.status, JSON.stringify(restartPayload)).toBe(409);
    expect(restartPayload).toMatchObject({ relaunched: false, error: { code: 'cli_update_in_progress' } });
    expect(inspectCliOperationAdmission()).toMatchObject({ blocked: true, installers: [{ runtime: 'claude-code', state: 'active' }] });
    const forced = await apply.POST(request('/api/panel/update/apply', { force: true }));
    expect(forced.status).toBe(409);
    expect(fixture.publish).not.toHaveBeenCalled(); expect(fixture.drain).not.toHaveBeenCalled();
    process.kill(Number(readFileSync(join(root, 'started'), 'utf8')), 0);
  } finally { writeFileSync(join(root, 'release'), 'finish'); installation = await pending; }
  expect(installation.status).toBe(200);
  expect(receipt()).toMatchObject({ status: 'succeeded', targetVersion: '2.0.2' });
  expect(existsSync(lockPath)).toBe(false); expect(existsSync(reservationPath)).toBe(false);
  expect((await relaunch.POST(request('/api/panel/app/relaunch'))).status).toBe(200);
  expect(fixture.drain).not.toHaveBeenCalled(); expect(fixture.publish).toHaveBeenCalledOnce();
  expect(readFileSync(join(fixture.home, '.claude/settings.json'), 'utf8')).toBe('{"autoUpdatesChannel":"stable"}');
}, 15_000);

it('refuses a new installer after native restart reserves the same persisted slot', async () => {
  const id = randomUUID(); mkdirSync(reservationPath);
  writeFileSync(join(reservationPath, `${id}.json`), JSON.stringify({ version: 1, id, kind: 'restart', pid: process.pid, startedAt: new Date().toISOString(), stage: 'preparing' }));
  const response = await updates.POST(request('/api/setup/cli-updates', { runtime: 'claude-code' }));
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'app_restart_pending' });
  expect(existsSync(join(root, 'started'))).toBe(false);
  expect(existsSync(join(reservationPath, `${id}.json`))).toBe(true);
});

it('keeps interrupted and legacy installer owners held with a recovery reason', async () => {
  const deadPid = Number(execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).trim());
  const id = randomUUID(); mkdirSync(reservationPath);
  writeFileSync(join(reservationPath, `${id}.json`), JSON.stringify({ version: 1, id, kind: 'installer', runtime: 'codex', pid: deadPid, startedAt: new Date().toISOString(), stage: 'installing' }));
  writeFileSync(join(dataDir, 'codex-cli-update.lock'), 'legacy-owner');
  const response = await relaunch.POST(request('/api/panel/app/relaunch'));
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'cli_update_recovery_required', message: expect.stringContaining('no lock was removed') } });
  expect(inspectCliOperationAdmission().installers[0]).toMatchObject({ state: 'interrupted' });
  expect(fixture.publish).not.toHaveBeenCalled(); expect(fixture.drain).not.toHaveBeenCalled();
  expect(readFileSync(join(dataDir, 'codex-cli-update.lock'), 'utf8')).toBe('legacy-owner');
  expect(existsSync(join(reservationPath, `${id}.json`))).toBe(true);
});

it('an old installer cleanup cannot remove a replacement operation or legacy lock', () => {
  const reservation = reserveCliInstaller('codex');
  renameSync(reservationPath, join(root, 'old-owner'));
  mkdirSync(reservationPath); writeFileSync(join(reservationPath, 'replacement'), 'preserve');
  writeFileSync(lockPath, JSON.stringify({ operationId: 'replacement' }));
  reservation.release(); releaseOwnedCliUpdateLock(lockPath, reservation.id);
  expect(readFileSync(join(reservationPath, 'replacement'), 'utf8')).toBe('preserve');
  expect(readFileSync(lockPath, 'utf8')).toContain('replacement');
  rmSync(join(root, 'old-owner'), { recursive: true });
});


it('keeps raw native process restart unavailable at the capability boundary', () => {
  const capability = JSON.parse(readFileSync(join(process.cwd(), 'src-tauri/capabilities/default.json'), 'utf8'));
  expect(capability.permissions).toContain('process:deny-restart');
  expect(capability.permissions).toContain('process:allow-exit');
  expect(capability.permissions).not.toContain('process:default');
  expect(capability.permissions).not.toContain('process:allow-restart');
});
