// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ModelRoutingControls } from './ModelRoutingControls';
import type { OperatorDefaultsResponse } from './dispatch-shared';

const { inventory } = vi.hoisted(() => ({ inventory: vi.fn() }));
vi.mock('../onboarding/useRuntimeInventory', () => ({ useRuntimeInventory: inventory }));
const refresh = vi.fn();
let container: HTMLDivElement;
let root: Root;
let fetcher: ReturnType<typeof vi.fn>;
const data = { values: { subscriptionProfile: 'hybrid', orchestratorBackend: 'auto', reviewerBackend: 'follow',
  defaultDispatchRuntime: 'pi', workerRuntimes: ['pi'] }, sources: {} } as unknown as OperatorDefaultsResponse;
const setup = { detected: true, agentDir: '/fixture/pi', version: '1.0.2', cacheWarming: 'streaming', cacheWarmingSupported: true,
  credentialsPresent: false, extensions: 0, skills: 0, sessions: 0, countsTruncated: false };
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  inventory.mockReturnValue({ inventory: [{ id: 'pi', available: true, piSetup: setup }], refresh });
  refresh.mockReset();
  fetcher = vi.fn(async () => Response.json({})); vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const button = (label: string) => [...container.querySelectorAll('button')].find(item => item.textContent === label);
const mount = () => act(async () => root.render(createElement(ModelRoutingControls, { data, busyField: null, updateField: vi.fn() })));

it('shows the detected mode and writes an explicit global choice from the production card', async () => {
  await mount();
  expect(container.textContent).toContain('Pi everywhere');
  const active = button('During runs');
  expect(active?.getAttribute('aria-pressed')).toBe('true');
  const off = button('Off');
  expect(off).not.toBeUndefined();
  await act(async () => off!.click());
  expect(fetcher).toHaveBeenCalledWith('/api/setup/pi/cache-warming', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ cacheWarming: 'off' }),
  }));
  expect(refresh).toHaveBeenCalledTimes(1);
});

it('hides the choice on older Pi and explains the required update', async () => {
  inventory.mockReturnValue({ inventory: [{ id: 'pi', available: true, piSetup: { ...setup, version: '0.85.9', cacheWarmingSupported: false } }], refresh });
  await mount();
  expect(container.textContent).toContain('Update Pi to 0.86.0 or newer');
  expect(button('During runs')).toBeUndefined();
});

it('keeps the saved choice and exposes a failed write with a retry', async () => {
  fetcher.mockImplementation(async (url: string) => url === '/api/setup/pi/cache-warming'
    ? Response.json({ error: 'Pi settings could not be saved.' }, { status: 409 }) : Response.json({}));
  await mount();
  await act(async () => button('Off')?.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Pi settings could not be saved.');
  expect(button('During runs')?.getAttribute('aria-pressed')).toBe('true');
  expect(button('Off')?.disabled).toBe(false);
  expect(refresh).not.toHaveBeenCalled();
});
