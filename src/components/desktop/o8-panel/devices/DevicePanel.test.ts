// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DevicePanel } from './DevicePanel';
import type { DeviceState } from '@/lib/devices/types';

const base: DeviceState = { phase: 'idle', tools: { hub: { installed: false, version: null, requiredVersion: '0.15.3' }, agent: { installed: false, version: null, requiredVersion: '0.21.23' } }, platforms: { ios: { available: true, detail: 'Xcode is available.' }, android: { available: false, detail: 'Install Android tools.' } } };
let host: HTMLDivElement; let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(base)));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
function findButton(label: string) { return [...host.querySelectorAll('button')].find(b => b.textContent === label)!; }
it('only inspects on entry, with explicit separate helper installation actions', async () => {
  await act(async () => root.render(createElement(DevicePanel, { active: true })));
  expect(vi.mocked(fetch).mock.calls.every(([, options]) => options?.method === undefined)).toBe(true);
  expect(host.textContent).toContain('SDKs and simulator images are installed separately.');
  await act(async () => findButton('Set up device viewer').click());
  expect(fetch).toHaveBeenLastCalledWith('/api/panel/devices', expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'install', tool: 'hub' }) }));
  await act(async () => findButton('Set up agent controls').click());
  expect(fetch).toHaveBeenLastCalledWith('/api/panel/devices', expect.objectContaining({ body: JSON.stringify({ action: 'install', tool: 'agent' }) }));
});
it('releases the embedded live viewer when hidden without stopping the simulator helper', async () => {
  vi.mocked(fetch).mockImplementation(async () => Response.json({ ...base, phase: 'running', embedUrl: 'http://127.0.0.1:3333/?token=test-fixture' }));
  await act(async () => root.render(createElement(DevicePanel, { active: true })));
  expect(host.querySelector('iframe')?.getAttribute('referrerpolicy')).toBe('no-referrer');
  expect(host.querySelector('iframe')?.getAttribute('sandbox')).not.toContain('allow-top-navigation');
  await act(async () => root.render(createElement(DevicePanel, { active: false })));
  expect(host.querySelector('iframe')).toBeNull();
  expect(vi.mocked(fetch).mock.calls.every(([, options]) => options?.method === undefined)).toBe(true);
  await act(async () => root.render(createElement(DevicePanel, { active: true })));
  expect(host.querySelector('iframe')).not.toBeNull();
  await act(async () => findButton('Stop viewer').click());
  expect(fetch).toHaveBeenLastCalledWith('/api/panel/devices', expect.objectContaining({ body: JSON.stringify({ action: 'stop' }) }));
});
it('shows API failures without starting another action automatically', async () => {
  vi.mocked(fetch).mockImplementation(async () => Response.json({ error: { message: 'Local operator required.' } }, { status: 403 }));
  await act(async () => root.render(createElement(DevicePanel, { active: true })));
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Local operator required.');
  expect(fetch).toHaveBeenCalledTimes(1);
});
