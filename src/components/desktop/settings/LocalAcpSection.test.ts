// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocalAcpSection } from './LocalAcpSection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const request = vi.fn();
const connection = { name: 'Saved agent', command: '/fixture/agent', args: ['acp'], useOpenRouter: false };
const agent = { id: 'fixture-agent', name: 'Fixture Agent', version: '1.0.0', description: 'A test agent', fingerprint: 'a'.repeat(64), npm: { package: 'fixture-agent@1.0.0', args: [] } };
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent?.trim() === label)!;
beforeEach(async () => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  request.mockReset(); request.mockImplementation(async (url: string) => Response.json(url.includes('acp-registry') ? { agents: [agent], stale: false } : { connection, envLocked: false }));
  vi.stubGlobal('fetch', request);
  await act(async () => root.render(createElement(LocalAcpSection)));
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('browses without installing, changing credentials, or replacing the current connection', async () => {
  await act(async () => button('Browse agents').click());
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Search ACP agents');
  expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-pressed]')!.click());
});

it('coalesces repeated preparation and leaves a separate save decision', async () => {
  await act(async () => button('Browse agents').click());
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-pressed]')!.click());
  let settle!: (value: Response) => void;
  request.mockImplementation((url: string) => url.endsWith('/prepare') ? new Promise(resolve => { settle = resolve; }) : Promise.resolve(Response.json({ connection })));
  await act(async () => { button('Prepare agent').click(); button('Prepare agent').click(); });
  expect(request.mock.calls.filter(([url]) => url.endsWith('/prepare'))).toHaveLength(1);
  await act(async () => settle(Response.json({ connection: { ...connection, name: 'Fixture Agent', command: '/fixture/node', args: ['/fixture/prepared.js'] } })));
  expect(container.querySelector<HTMLInputElement>('input')!.value).toBe('Fixture Agent');
  expect(container.textContent).toContain('Your current connection stays active until you save');
  expect(request.mock.calls.some(([url, options]) => url.endsWith('acp-connection') && options?.method === 'POST')).toBe(false);
});

it('retains local fields when registry browsing is dismissed', async () => {
  await act(async () => button('Browse agents').click());
  await act(async () => button('Close').click());
  expect(container.querySelector<HTMLInputElement>('input')!.value).toBe('Saved agent');
  expect(container.querySelector('section[aria-label="ACP agent registry"]')).toBeNull();
});

it('submits one save for repeated clicks before a render', async () => {
  let settle!: (value: Response) => void;
  request.mockImplementation(() => new Promise(resolve => { settle = resolve; }));
  await act(async () => { button('Save connection').click(); button('Save connection').click(); });
  expect(request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  await act(async () => settle(Response.json({ connection })));
});

it('ignores a prepared connection that finishes after the picker was dismissed', async () => {
  await act(async () => button('Browse agents').click());
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-pressed]')!.click());
  let settle!: (value: Response) => void;
  request.mockImplementation(() => new Promise(resolve => { settle = resolve; }));
  await act(async () => button('Prepare agent').click());
  await act(async () => button('Close').click());
  await act(async () => settle(Response.json({ connection: { ...connection, name: 'Late agent' } })));
  expect(container.querySelector<HTMLInputElement>('input')!.value).toBe('Saved agent');
  expect(document.activeElement).toBe(container.querySelector('input[placeholder="agent executable or full path"]'));
});
