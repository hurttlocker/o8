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
  expect(blocked).toHaveBeenCalledWith(expect.stringContaining('still running'));
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
