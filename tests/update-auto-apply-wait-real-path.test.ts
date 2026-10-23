import { afterAll, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ busy: false }));
vi.mock('@/lib/app-update/idle-window', () => ({ getUpdateIdleWindow: async () => ({
  idle: !fixture.busy, idleExceptParked: !fixture.busy, parkedLanes: [], unavailable: [],
  active: { terminalSessions: fixture.busy ? [{ name: 'temporary-work' }] : [] },
}) }));
const { POST } = await import('@/app/api/panel/app/update-state/route');
const { setAppUpdateState } = await import('@/lib/app-update/relaunch-state');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
afterAll(() => vi.unstubAllEnvs());

it('waits after busy post-download admission and admits the same version when work settles', async () => {
  // The isolated fixture uses a self-updatable install on every test host.
  vi.stubEnv('APPIMAGE', '/fixture/o8.AppImage');
  await updateOperatorDefaults({ updateAutoApply: 'idle' });
  setAppUpdateState({ updatePending: true, version: '0.2.0' });
  const send = async (autoApply: object) => (await POST(new Request('http://localhost/api/panel/app/update-state', {
    method: 'POST', body: JSON.stringify({ autoApply }),
  }))).json();
  expect(await send({ action: 'admit', attemptId: 'first-attempt' })).toMatchObject({ allowed: true });
  fixture.busy = true;
  expect(await send({ action: 'install', attemptId: 'first-attempt' })).toMatchObject({ allowed: false,
    state: { autoApply: { phase: 'waiting', installed: false } } });
  const waiting = await send({ action: 'wait', attemptId: 'first-attempt' });
  expect(waiting.state.lastInstall).toBeNull();
  expect(waiting.state.autoApply).toMatchObject({ phase: 'waiting', attemptId: null, error: null });
  expect(waiting.state.autoApply.manualRetryRequired).not.toBe(true);
  fixture.busy = false;
  expect(await send({ action: 'admit', attemptId: 'second-attempt' })).toMatchObject({ allowed: true, version: '0.2.0' });
});
