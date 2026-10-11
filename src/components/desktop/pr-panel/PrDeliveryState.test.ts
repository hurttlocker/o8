// @vitest-environment jsdom
import { act, createElement, createRef, forwardRef, useImperativeHandle } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePrComment } from './usePrComment';
import { usePrCheckout } from './usePrCheckout';
const sha = 'a'.repeat(40);
let root: Root; let host: HTMLDivElement;
type Handle = { writer: ReturnType<typeof usePrComment>; checkout: ReturnType<typeof usePrCheckout> };
const handle = createRef<Handle>();
const Fixture = forwardRef<Handle, { number: number }>(function Fixture({ number }, ref) { const writer = usePrComment('example/locks', number); const checkout = usePrCheckout('example/locks', number, '/workspace'); useImperativeHandle(ref, () => ({ writer, checkout }), [writer, checkout]); return null; });
const render = (number: number) => act(async () => root.render(createElement(Fixture, { number, ref: handle })));
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement('div'); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
describe('unresolved PR delivery state', () => {
  it.each(['uncertain', 'partial'] as const)('retains %s comment protection after more than 40 other PR actions', async (kind) => {
    const first = kind === 'uncertain' ? 11000 : 12000;
    const mock = vi.fn().mockImplementationOnce(() => kind === 'uncertain' ? Promise.reject(new Error('lost receipt')) : Promise.resolve(Response.json({ commentPosted: true, ok: false }, { status: 502 }))).mockImplementation(() => Promise.resolve(Response.json({ ok: true })));
    vi.stubGlobal('fetch', mock); await render(first);
    await act(async () => { await handle.current!.writer.post('Comment', kind === 'partial' ? 'close-with-comment' : 'comment'); });
    for (let offset = 1; offset <= 45; offset++) { await render(first + offset); await act(async () => { await handle.current!.writer.post('Another comment'); }); }
    await render(first); expect(kind === 'uncertain' ? handle.current!.writer.uncertain : handle.current!.writer.partialClose).toBe(true);
    const count = mock.mock.calls.length; await act(async () => { await handle.current!.writer.post('Do not repeat'); }); expect(mock).toHaveBeenCalledTimes(count);
  });
  it('retains an unconfirmed checkout after more than 40 other workspace requests', async () => {
    const mock = vi.fn().mockRejectedValueOnce(new Error('lost receipt')).mockImplementation(() => Promise.resolve(Response.json({ ok: true, workspace: { path: '/workspace/review', branch: 'review', commitSha: sha } })));
    vi.stubGlobal('fetch', mock); await render(13000); await act(async () => { await handle.current!.checkout.checkout(sha); });
    for (let offset = 1; offset <= 45; offset++) { await render(13000 + offset); await act(async () => { await handle.current!.checkout.checkout(sha); }); }
    await render(13000); expect(handle.current!.checkout.uncertain).toBe(true); const count = mock.mock.calls.length;
    await act(async () => { await handle.current!.checkout.checkout(sha); }); expect(mock).toHaveBeenCalledTimes(count);
  });
});
