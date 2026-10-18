/** @vitest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import type { LiveBackend } from '@/lib/voice/managed-live/session';
const fixture = vi.hoisted(() => ({ backend: null as LiveBackend | null }));
vi.mock('@/lib/mobile/ws-token-client', () => ({ getMobileWsToken: () => 'fixture' }));
vi.mock('@/lib/voice/managed-live/session', () => ({ startManagedLive: async (backend: LiveBackend, onState: (state: string) => void) => {
  fixture.backend = backend; onState('live'); return { state: 'live', close: async () => { onState('closed'); }, activity() {} };
} }));
import { ManagedLiveButton } from './ManagedLiveButton';
let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ enabled: true, entitled: true })));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it('serializes same-poll delegations and waits for correlated terminal even if append acknowledgement is delayed or rejected', async () => {
  const send = vi.fn(() => ({ userMessageId: 'user-1' }));
  const props = { binding: 'repo:thread:claude:model', messages: [], busy: false, terminals: {}, send, interrupt: vi.fn() };
  await act(async () => root.render(createElement(ManagedLiveButton, props)));
  await act(async () => container.querySelector('button')!.click());
  const update = vi.fn(async (): Promise<void> => { throw new Error('append unavailable'); });
  const blocked = vi.fn(async () => {});
  const task = fixture.backend!.delegate('Do this', 'one', update);
  await fixture.backend!.delegate('Another task', 'two', blocked);
  expect(send).toHaveBeenCalledOnce();
  expect(blocked).toHaveBeenCalledWith(expect.stringContaining('cannot apply an immediate correction'));
  // Optimistic ready and a partial assistant bubble are not terminal evidence.
  await act(async () => root.render(createElement(ManagedLiveButton, { ...props, messages: [
    { id: 'user-1', role: 'user', text: 'Do this' }, { id: 'assistant', role: 'assistant', text: 'partial' },
  ] })));
  expect(update).toHaveBeenCalledTimes(1);
  update.mockResolvedValue(undefined);
  await act(async () => root.render(createElement(ManagedLiveButton, { ...props,
    terminals: { 'user-1': { outcome: 'unconfirmed', text: 'partial' } } })));
  await fixture.backend!.delegate('Try again', 'three', blocked);
  expect(send).toHaveBeenCalledOnce();
  expect(update).toHaveBeenLastCalledWith(expect.stringContaining('has not confirmed'));

  await act(async () => root.render(createElement(ManagedLiveButton, { ...props,
    terminals: { 'user-1': { outcome: 'interrupted', text: 'partial' } } })));
  await task;
  expect(update).toHaveBeenLastCalledWith('The backend confirmed interruption.');
});

it('allows voice restart when the app remounts with the new binding key', async () => {
  const props = { key: 'repo:thread:claude:model', binding: 'repo:thread:claude:model', messages: [], busy: false, terminals: {}, send: vi.fn(), interrupt: vi.fn() };
  await act(async () => root.render(createElement(ManagedLiveButton, props)));
  await act(async () => container.querySelector('button')!.click());
  expect(container.querySelector('button')!.getAttribute('aria-pressed')).toBe('true');
  await act(async () => root.render(createElement(ManagedLiveButton, {...props, key:'repo:other-thread:codex:model', binding:'repo:other-thread:codex:model'})));
  await act(async () => container.querySelector('button')!.click());
  expect(container.querySelector('button')!.disabled).toBe(false);
  expect(fixture.backend!.binding).toBe('repo:other-thread:codex:model');
});

it('offers explicit resume after closure without reconnecting itself', async () => {
  const props = { binding: 'repo:thread:claude:model', messages: [], busy: false, terminals: {}, send: vi.fn(), interrupt: vi.fn() };
  await act(async () => root.render(createElement(ManagedLiveButton, props)));
  await act(async () => container.querySelector('button')!.click());
  const previous = fixture.backend;
  await act(async () => container.querySelector('button')!.click());
  expect(container.querySelector('button')!.textContent).toBe('Resume voice');
  expect(fixture.backend).toBe(previous);
  await act(async () => container.querySelector('button')!.click());
  expect(container.querySelector('button')!.textContent).toBe('Disconnect voice');
  expect(fixture.backend!.binding).toBe(props.binding);
});

it('queues only explicit follow-up consent, waits for exact terminal, and delivers after voice resume', async () => {
  const send = vi.fn().mockReturnValueOnce({userMessageId:'user-one'}).mockReturnValueOnce({userMessageId:'user-two'});
  const props = {binding:'same-thread',messages:[],busy:false,terminals:{},send,interrupt:vi.fn()};
  await act(async()=>root.render(createElement(ManagedLiveButton,props)));
  await act(async()=>container.querySelector('button')!.click());
  const update = vi.fn(async()=>{});
  const first = fixture.backend!.delegate('Start task','first',update);
  await fixture.backend!.delegate('Actually change it','correction',update);
  expect(send).toHaveBeenCalledTimes(1);
  await fixture.backend!.delegate('queue check the tests','follow-up',update);
  expect(update).toHaveBeenLastCalledWith(expect.stringContaining('not been submitted or applied'));
  const messages = [{id:'user-one',role:'user' as const,text:'Start task'}];
  await act(async()=>root.render(createElement(ManagedLiveButton,{...props,messages,terminals:{'user-one':{outcome:'unconfirmed',text:''}}})));
  expect(send).toHaveBeenCalledTimes(1);
  await act(async()=>container.querySelector('button')!.click());
  await act(async()=>container.querySelector('button')!.click());
  const resumed = vi.fn(async()=>{}); fixture.backend!.subscribe!(resumed);
  await act(async()=>root.render(createElement(ManagedLiveButton,{...props,messages,terminals:{'user-one':{outcome:'completed',text:'Verified original result'}}})));
  await first;
  expect(send).toHaveBeenNthCalledWith(2,'check the tests');
  expect(resumed).toHaveBeenCalledWith('Verified original result',true);
  await act(async()=>root.render(createElement(ManagedLiveButton,{...props,messages,terminals:{'user-one':{outcome:'completed',text:'Verified original result'}}})));
  expect(send).toHaveBeenCalledTimes(2); expect(props.interrupt).not.toHaveBeenCalled();
});

it('cancels deliberate queue without interrupting the doer', async () => {
  const props = {binding:'same-thread',messages:[{id:'running',role:'user' as const,text:'Work'}],busy:true,terminals:{},send:vi.fn(),interrupt:vi.fn()};
  await act(async()=>root.render(createElement(ManagedLiveButton,props)));
  await act(async()=>container.querySelector('button')!.click());
  const update=vi.fn(async()=>{});
  await fixture.backend!.delegate('queue next step','queue',update);
  await fixture.backend!.delegate('cancel queued','cancel',update);
  await act(async()=>root.render(createElement(ManagedLiveButton,{...props,busy:false,terminals:{running:{outcome:'completed',text:'done'}}})));
  expect(props.send).not.toHaveBeenCalled(); expect(props.interrupt).not.toHaveBeenCalled();
});

it('does not auto-submit a follow-up after the same utterance withdraws queue consent', async () => {
  const props={binding:'same',messages:[{id:'running',role:'user' as const,text:'Work'}],busy:true,terminals:{},send:vi.fn(()=>({userMessageId:'next'})),interrupt:vi.fn()};
  await act(async()=>root.render(createElement(ManagedLiveButton,props)));
  await act(async()=>container.querySelector('button')!.click());
  await fixture.backend!.delegate('queue check tests, actually do not queue that','q',vi.fn(async()=>{}));
  await act(async()=>root.render(createElement(ManagedLiveButton,{...props,busy:false,terminals:{running:{outcome:'completed',text:'done'}}})));
  expect(props.send).not.toHaveBeenCalled();
});

it('drops queued consent across the real keyed conversation remount', async () => {
  const props={key:'a',binding:'a',messages:[{id:'running',role:'user' as const,text:'Work'}],busy:true,terminals:{},send:vi.fn(()=>({userMessageId:'next'})),interrupt:vi.fn()};
  await act(async()=>root.render(createElement(ManagedLiveButton,props)));
  await act(async()=>container.querySelector('button')!.click());
  const oldBackend=fixture.backend!;
  await oldBackend.delegate('queue check tests','q',vi.fn(async()=>{}));
  await act(async()=>root.render(createElement(ManagedLiveButton,{...props,key:'b',binding:'b',busy:false,terminals:{running:{outcome:'completed',text:'done'}}})));
  await act(async()=>container.querySelector('button')!.click());
  expect(fixture.backend!.binding).toBe('b'); expect(props.send).not.toHaveBeenCalled();
});

it('does not drain a follow-up when a different user turn owns current conversation', async () => {
  const props={binding:'same',messages:[{id:'running',role:'user' as const,text:'Work'}],busy:true,terminals:{},send:vi.fn(()=>({userMessageId:'next'})),interrupt:vi.fn()};
  await act(async()=>root.render(createElement(ManagedLiveButton,props)));
  await act(async()=>container.querySelector('button')!.click());
  await fixture.backend!.delegate('queue check tests','q',vi.fn(async()=>{}));
  const messages=[...props.messages,{id:'external',role:'user' as const,text:'Other work'}];
  await act(async()=>root.render(createElement(ManagedLiveButton,{...props,messages,busy:false,terminals:{running:{outcome:'completed',text:'done'}}})));
  expect(props.send).not.toHaveBeenCalled();
});
