// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteTaskPreview } from './RemoteTaskPreview';

vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => true }));
vi.mock('@/lib/tauri/remote-preview', () => ({ remotePreviewSupported: async () => true }));
vi.mock('@/components/desktop/NativeRemotePreview', () => ({ NativeRemotePreview: () => null }));
vi.mock('./shared', () => ({ ActionButton: ({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) => (
  createElement('button', { disabled, onClick }, label)
) }));
let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; container?.remove(); vi.unstubAllGlobals(); });

async function ready() {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let fail!: (error: Error) => void;
  let posts = 0;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', (_url: string, options: { method: string; body: string }) => {
    calls.push({ method: options.method, body: JSON.parse(options.body) });
    if (options.method === 'DELETE') return Promise.resolve(Response.json({ ok: true }));
    if (++posts === 1) return Promise.resolve(Response.json({ id: 'listener', url: 'http://[::1]:1234/', serviceJobId: 'service-1' }));
    return new Promise<Response>((_resolve, reject) => { fail = reject; });
  });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(createElement(RemoteTaskPreview, { taskId: 'task-1', jobId: 'result-1', attempt: 1, onBack: () => {} })));
  const reconnect = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Reconnect')!;
  expect(reconnect).toBeTruthy();
  await act(async () => reconnect.click());
  return { calls, fail };
}

describe('preview pane cleanup ownership across reconnect', () => {
  it('stops the retained child if the first reconnect request fails', async () => {
    const { calls, fail } = await ready();
    await act(async () => fail(new Error('connection lost')));
    expect(calls).toContainEqual({ method: 'DELETE', body: { serviceJobId: 'service-1', keepService: false } });
  });

  it('stops the retained child on unmount while reconnect is still in flight', async () => {
    const { calls, fail } = await ready();
    await act(async () => root!.unmount()); root = null;
    expect(calls).toContainEqual({ method: 'DELETE', body: { serviceJobId: 'service-1', keepService: false } });
    await act(async () => fail(new Error('connection lost')));
  });
});
