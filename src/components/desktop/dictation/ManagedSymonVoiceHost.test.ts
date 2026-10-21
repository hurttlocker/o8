/** @vitest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ state: 'live', notify: (_state: string) => {}, starts: vi.fn(), backend: { binding: 'symon:same-session' } }));
vi.mock('@/lib/voice/managed-live/symon-backend', () => ({
  getManagedSymonBackend: async () => fixture.backend,
  subscribeManagedSymonConfirmation: () => () => {},
}));
vi.mock('@/lib/voice/managed-live/session', () => ({ startManagedLive: async (backend: unknown, notify: (state: string) => void) => {
  fixture.starts(backend); fixture.notify = notify; fixture.state = 'live'; notify('live');
  return { get state() { return fixture.state; }, close: async () => { fixture.state = 'closed'; notify('closed'); } };
} }));
import { ManagedSymonVoiceHost } from './ManagedSymonVoiceHost';
it('shows explicit resume after idle closure and retains the same Symon backend', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const element = document.createElement('div'); document.body.append(element); const root = createRoot(element);
  try {
    await act(async () => root.render(createElement(ManagedSymonVoiceHost)));
    await act(async () => window.dispatchEvent(new Event('o8:managed-symon-toggle')));
    expect(fixture.starts).toHaveBeenCalledTimes(1);
    await act(async () => { fixture.state = 'closed'; fixture.notify('closed'); });
    expect(element.querySelector('button')!.textContent).toContain('Resume Symon voice');
    expect(fixture.starts).toHaveBeenCalledTimes(1);
    await act(async () => element.querySelector('button')!.click());
    expect(fixture.starts).toHaveBeenCalledTimes(2);
    expect(fixture.starts.mock.calls[0][0]).toBe(fixture.starts.mock.calls[1][0]);
  } finally { act(() => root.unmount()); element.remove(); }
});
