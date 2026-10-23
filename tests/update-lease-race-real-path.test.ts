import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ disappear: '', published: vi.fn(async () => true) }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, existsSync: (path: Parameters<typeof fs.existsSync>[0]) => {
    const exists = fs.existsSync(path);
    if (exists && String(path) === fixture.disappear) {
      fixture.disappear = '';
      fs.rmSync(path, { recursive: true });
    }
    return exists;
  } };
});
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: fixture.published }));
vi.mock('@/lib/app-update/idle-window', () => ({ getUpdateIdleWindow: async () => ({ idle: true, idleExceptParked: true,
  parkedLanes: [], unavailable: [], active: { lanes: [], terminalSessions: [], managedRuns: [], ownedSessions: [], cloudJobs: [] } }) }));
const { mkdirSync, readdirSync, readFileSync } = await import('node:fs');
const { getDataDir } = await import('@/lib/data-dir-migration');
const { setAppUpdateState } = await import('@/lib/app-update/relaunch-state');
const apply = await import('@/app/api/panel/update/apply/route');
const relaunch = await import('@/app/api/panel/app/relaunch/route');
afterEach(() => { fixture.disappear = ''; });

it.each(['apply', 'relaunch'])('records and accepts forced %s when an installer settles during inventory', async entry => {
  setAppUpdateState({ updatePending: true, version: '0.2.0' });
  const directory = join(getDataDir(), 'cli-operation-admission');
  mkdirSync(directory, { recursive: true });
  fixture.disappear = directory;
  const response = await (entry === 'apply' ? apply : relaunch).POST(new Request(`http://localhost/api/panel/${entry}`, {
    method: 'POST', body: JSON.stringify({ force: true }),
  }));
  expect(response.status).toBe(entry === 'apply' ? 202 : 200);
  const receipts = join(getDataDir(), 'forced-restarts');
  expect(readdirSync(receipts).some(name => readFileSync(join(receipts, name), 'utf8').includes('cli_update_inventory_unavailable'))).toBe(true);
});

it.skipIf(process.platform === 'win32')('records unknown launch inventory without reading or reclaiming a symlink target', async () => {
  const { existsSync, symlinkSync, rmSync, writeFileSync } = await import('node:fs');
  const data = getDataDir(); const target = join(data, 'unrelated'); const launches = join(data, 'work-launches');
  mkdirSync(target, { recursive: true });
  const id = '11111111-1111-4111-8111-111111111111';
  const path = join(target, `${id}.json`);
  writeFileSync(path, JSON.stringify({ id, label: 'preserve', pid: null, ownerPid: process.pid, createdAtMs: 1 }));
  symlinkSync(target, launches);
  try {
    const response = await apply.POST(new Request('http://localhost/api/panel/update/apply', { method: 'POST', body: JSON.stringify({ force: true }) }));
    expect(response.status).toBe(202);
    expect(existsSync(path)).toBe(true);
  } finally { rmSync(launches); }
});
