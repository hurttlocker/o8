/** @vitest-environment jsdom */
import { act, createElement, type ComponentProps } from 'react';
import type { QueuedComposerSendRecord } from '@/lib/orchestrator/composer-queue-types';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import type { LiveBackend } from '@/lib/voice/managed-live/session';
const fixture = vi.hoisted(() => ({ backend: null as LiveBackend | null }));
vi.mock('@/lib/mobile/ws-token-client', () => ({ getMobileWsToken: () => 'fixture' }));
vi.mock('@/lib/voice/managed-live/session', () => ({ startManagedLive: async (backend: LiveBackend, onState: (state: string) => void) => {
  let state = 'live'; fixture.backend = backend; onState(state); return { get state() { return state; }, close: async () => { state = 'closed'; onState(state); }, activity() {} };
} }));
import { ManagedLiveButton as VoiceButton } from './ManagedLiveButton';
const queues = new Map<string, QueuedComposerSendRecord[]>();
const saved = vi.fn();
function ManagedLiveButton(props: ComponentProps<typeof VoiceButton>) {
  return createElement(VoiceButton, { ...props, followup: {
    ready: true, items: queues.get(props.binding) ?? [],
    enqueue: async (id, text, afterTaskId) => {
      saved(id, text, afterTaskId, props.binding);
      queues.set(props.binding, [{ id, sequence: 1, threadId: props.binding, repoPath: '/repo', intent: 'send-next',
        status: 'queued', reason: null, createdAt: 1, updatedAt: 1, admittedAt: null,
        payload: { text, wireMessage: text, afterTaskId, images: [], routing: { backend: 'codex', model: 'model',
          effort: 'high', permissionMode: 'plan', mode: 'fleet', pickedMode: 'multitask', collide: false, pinBackend: true } } }]);
    },
    cancel: async () => { queues.delete(props.binding); return 'Queued voice follow-up canceled before submission. The running task is unchanged.'; },
  } });
}
let root: Root; let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  queues.clear(); saved.mockClear();
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ enabled: true, entitled: true })));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('projects captions only into their bound chat and links accepted sends without treating voice output as completion', async () => {
  const transcript = vi.fn(); const submitted = vi.fn();
  const props = { key: 'a', binding: 'a', messages: [], busy: false, terminals: {}, transcript, send: vi.fn(() => ({ userMessageId: 'orch-user-a' })), interrupt: vi.fn() };
  await act(async () => root.render(createElement(ManagedLiveButton, props)));
  await act(async () => container.querySelector('button')!.click());
  const old = fixture.backend!;
  old.transcript!([{ id: 'spoken', role: 'user', text: 'Check this' }]);
  expect(transcript).toHaveBeenCalledOnce();
  void old.delegate('Check this', 'd', vi.fn(async () => {}), submitted);
  expect(submitted).toHaveBeenCalledWith('orch-user-a');
  await act(async () => root.render(createElement(ManagedLiveButton, { ...props, key: 'b', binding: 'b' })));
  old.transcript!([{ id: 'late', role: 'assistant', text: 'Old voice' }]);
  expect(transcript).toHaveBeenCalledOnce();
});
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
  expect(container.querySelector('button')!.getAttribute('aria-label')).toBe('Resume managed voice for this conversation');
  expect(fixture.backend).toBe(previous);
  await act(async () => container.querySelector('button')!.click());
  expect(container.querySelector('button')!.getAttribute('aria-label')).toBe('Disconnect managed voice');
  expect(fixture.backend!.binding).toBe(props.binding);
});

it('persists explicit follow-up consent through the shared queue and never drains it from the voice component', async () => {
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
  expect(saved).toHaveBeenCalledWith(expect.stringMatching(/^voice-/), 'check the tests', 'user-one', 'same-thread');
  expect(send).toHaveBeenCalledTimes(1);
  expect(resumed).toHaveBeenCalledWith('Verified original result',true);
  await act(async()=>root.render(createElement(ManagedLiveButton,{...props,messages,terminals:{'user-one':{outcome:'completed',text:'Verified original result'}}})));
  expect(send).toHaveBeenCalledTimes(1); expect(props.interrupt).not.toHaveBeenCalled();
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

it('leaves the persisted queue with its originating chat across a keyed remount', async () => {
  const props={key:'a',binding:'a',messages:[{id:'running',role:'user' as const,text:'Work'}],busy:true,terminals:{},send:vi.fn(()=>({userMessageId:'next'})),interrupt:vi.fn()};
  await act(async()=>root.render(createElement(ManagedLiveButton,props)));
  await act(async()=>container.querySelector('button')!.click());
  const oldBackend=fixture.backend!;
  await oldBackend.delegate('queue check tests','q',vi.fn(async()=>{}));
  await act(async()=>root.render(createElement(ManagedLiveButton,{...props,key:'b',binding:'b',busy:false,terminals:{running:{outcome:'completed',text:'done'}}})));
  await act(async()=>container.querySelector('button')!.click());
  expect(fixture.backend!.binding).toBe('b'); expect(props.send).not.toHaveBeenCalled();
  expect(queues.get('a')?.[0].payload.afterTaskId).toBe('running'); expect(queues.get('b')).toBeUndefined();
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


it('Caps Lock uses the focused composer and a second tap closes voice without stopping backend work', async () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const interrupt = vi.fn();
  const props = { messages: [], busy: false, terminals: {}, send: vi.fn(), interrupt };
  await act(async () => root.render(createElement('div', null,
    ...['first-chat', 'second-chat'].map(binding => createElement('section', { key: binding, 'data-voice-chat-root': true },
      createElement('div', null, 'Transcript'), createElement(ManagedLiveButton, { ...props, binding }), createElement('textarea'))))));
  const buttons = container.querySelectorAll('button');
  await act(async () => container.querySelectorAll('textarea')[1].focus());
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'CapsLock' })));
  expect(fixture.backend!.binding).toBe('second-chat');
  expect(buttons[0].getAttribute('aria-pressed')).toBe('false');
  expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
  await act(async () => buttons[0].focus());
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'CapsLock', repeat: true })));
  expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'CapsLock' })));
  expect(buttons[1].getAttribute('aria-pressed')).toBe('false');
  expect(interrupt).not.toHaveBeenCalled();
});

it('does not accept a stale delegation after the same chat starts a new voice activation', async () => {
  const send = vi.fn(() => ({ userMessageId: 'new' }));
  const props = { binding: 'same', messages: [], busy: false, terminals: {}, send, interrupt: vi.fn() };
  await act(async () => root.render(createElement(ManagedLiveButton, props)));
  await act(async () => container.querySelector('button')!.click());
  const old = fixture.backend!;
  await act(async () => container.querySelector('button')!.click());
  await act(async () => container.querySelector('button')!.click());
  expect(fixture.backend).not.toBe(old);
  await old.delegate('Late old request', 'old', vi.fn(async () => {}));
  expect(send).not.toHaveBeenCalled();
});
