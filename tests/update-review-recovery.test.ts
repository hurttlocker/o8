import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, expect, it, vi } from 'vitest';

const directory = mkdtempSync(join(tmpdir(), 'o8-update-recovery-'));
vi.stubEnv('O8_DATA_DIR', directory);
vi.stubEnv('CORTEX_IDE_DATA_DIR', directory);
const { POST } = await import('@/app/api/panel/app/update-state/route');
const { recordAutoApply, recordAppUpdateInstall } = await import('@/lib/app-update/relaunch-state');
afterAll(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

it('recovers manual installation only after the native task proves it has stopped', async () => {
  const attemptId = randomUUID();
  mkdirSync(join(directory, 'native-update-tasks'));
  const file = join(directory, 'native-update-tasks', `${attemptId}.json`);
  recordAppUpdateInstall({ outcome: 'started', version: '0.2.0' });
  recordAutoApply({ attemptId, version: '0.2.0', installed: false, phase: 'installing', blockers: { live: [], parked: [] }, error: null });
  const install = () => POST(new Request('http://localhost/api/panel/app/update-state', {
    method: 'POST', body: JSON.stringify({ install: { outcome: 'started', version: '0.2.0' } }),
  }));
  // Neither a missing receipt nor a live receipt grants recovery, regardless of age.
  expect((await install()).status).toBe(409);
  writeFileSync(file, JSON.stringify({ attemptId, pid: process.pid, status: 'running' }));
  expect((await install()).status).toBe(409);
  writeFileSync(file, JSON.stringify({ attemptId, pid: process.pid, status: 'stopped' }));
  expect((await install()).status).toBe(200);
});

it('retires a stopped native owner before considering replacement admission', async () => {
  const { setAppUpdateState } = await import('@/lib/app-update/relaunch-state');
  const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
  // Inventory is a real local endpoint in the existing parked real-path fixture;
  // this assertion verifies recovery occurs before the new admission inventory.
  const id = randomUUID();
  recordAppUpdateInstall({ outcome: 'started', version: '0.2.1' });
  recordAutoApply({ attemptId: id, version: '0.2.1', installed: false, phase: 'installing', blockers: { live: [], parked: [] }, error: null });
  writeFileSync(join(directory, 'native-update-tasks', `${id}.json`), JSON.stringify({ attemptId: id, pid: process.pid, status: 'stopped' }));
  setAppUpdateState({ updatePending: true, version: '0.2.1' });
  await updateOperatorDefaults({ updateAutoApply: 'off' });
  await POST(new Request('http://localhost/api/panel/app/update-state', { method: 'POST', body: JSON.stringify({ autoApply: { action: 'admit', attemptId: randomUUID() } }) }));
  const { getAppUpdateState } = await import('@/lib/app-update/relaunch-state');
  expect(getAppUpdateState().lastInstall?.outcome).toBe('failed');
  expect(getAppUpdateState().autoApply?.phase).toBe('failed');
});
