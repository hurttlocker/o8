/** @vitest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkerCorrections } from './WorkerCorrections';

vi.mock('@/components/desktop/hooks/DesktopWebSocketContext', () => ({ useSharedDesktopWs: vi.fn() }));
const worker = { surfaceId: 'codex-owned:one', runId: 'run-one', runtime: 'codex', taskName: 'Inspect code', running: true };
let host: HTMLDivElement; let root: Root;
const delivered = vi.fn();
const calls: Array<Record<string, unknown>> = [];
let response: (body: Record<string, unknown>) => Promise<unknown>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear(); calls.length = 0; delivered.mockClear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (init?.method === 'POST') { const body = JSON.parse(init.body); calls.push(body); return response(body); }
    return { ok: true, json: async () => ({ workers: [worker], corrections: [] }) };
  }));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function render(draft = 'Use the existing worker.', threadId = 'thoughts-one') {
  await act(async () => root.render(createElement(WorkerCorrections, { repoPath: '/repo', threadId, draft,
    hasAttachments: false, working: false, onDelivered: delivered })));
}
function button(text: string) {
  const found = [...host.querySelectorAll('button')].find(item => item.textContent?.includes(text));
  expect(found, text).toBeTruthy(); return found!;
}
async function choose() {
  await act(async () => button('Correct workers').click());
  await act(async () => host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
}
function accepted(body: Record<string, unknown>) {
  return { ok: true, json: async () => ({ receipt: { ...body, deliveries: [{ ...worker, status: 'delivered', note: 'Accepted, not acknowledged.' }] } }) };
}

it('reconciles an uncertain request after reload with its original identity and payload', async () => {
  response = async () => { throw new Error('Connection lost'); };
  await render(); await choose();
  await act(async () => button('Pause and correct selected').click());
  expect(calls).toHaveLength(1); expect(delivered).not.toHaveBeenCalled();
  await act(async () => root.unmount()); root = createRoot(host);
  response = async body => accepted(body);
  await render('A newer draft.');
  await act(async () => button('Correct workers').click());
  await act(async () => button('Check pending correction').click());
  expect(calls[1]).toEqual(calls[0]);
  expect(delivered).not.toHaveBeenCalled();
  expect(localStorage.length).toBe(0);
});

it('releases a confirmed pre-admission rejection so a changed selection is usable', async () => {
  response = async () => ({ ok: false, json: async () => ({ error: 'Worker changed.', notAdmitted: true }) });
  await render(); await choose();
  await act(async () => button('Pause and correct selected').click());
  expect(host.textContent).toContain('Worker changed.'); expect(localStorage.length).toBe(0);
  response = async body => accepted(body);
  await render('Correct the new turn.');
  await act(async () => button('Pause and correct selected').click());
  expect(calls[1].id).not.toBe(calls[0].id);
  expect(calls[1].payload).toMatchObject({ message: 'Correct the new turn.' });
  expect(delivered).toHaveBeenCalledWith('Correct the new turn.');
});

it('preserves a draft edited while runtime delivery is still pending', async () => {
  let finish!: () => void;
  response = async body => { await new Promise<void>(resolve => { finish = resolve; }); return accepted(body); };
  await render(); await choose();
  await act(async () => button('Pause and correct selected').click());
  expect(host.querySelector('progress')).toBeNull();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)); });
  expect(host.querySelector('progress')).not.toBeNull();
  await render('Keep this newer message.');
  await act(async () => finish());
  expect(delivered).not.toHaveBeenCalled();
});

it('keeps the composer usable when the worker endpoint returns an unexpected response', async () => {
  vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
  await render();
  await act(async () => button('Correct workers').click());
  expect(host.querySelector('[role=alert]')?.textContent).toContain('invalid response');
  expect(calls).toHaveLength(0);
});

it('does not carry an in-flight correction lock into another conversation', async () => {
  let finish!: () => void;
  response = async body => { await new Promise<void>(resolve => { finish = resolve; }); return accepted(body); };
  await render(); await choose();
  await act(async () => button('Pause and correct selected').click());
  await render('The other conversation.', 'thoughts-two'); await choose();
  expect(button('Pause and correct selected').disabled).toBe(false);
  await act(async () => finish());
  expect(delivered).not.toHaveBeenCalled();
  expect(button('Pause and correct selected').disabled).toBe(false);
});
