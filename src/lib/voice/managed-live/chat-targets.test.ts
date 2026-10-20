import { expect, it, vi } from 'vitest';
import { ManagedChatVoiceTargets, type ManagedChatVoiceTarget } from './chat-targets';
import type { LiveState } from './session';

function chat() {
  let state: LiveState = 'idle'; let visible = true;
  const target: ManagedChatVoiceTarget = { eligible: () => visible, state: () => state,
    toggle: vi.fn(async () => { state = state === 'idle' || state === 'closed' ? 'live' : 'closed'; }) };
  return { target, phase: (value: LiveState) => { state = value; }, hide: () => { visible = false; } };
}
it('starts only the focused chat and stops that same voice owner after focus moves', async () => {
  const registry = new ManagedChatVoiceTargets(); const a = chat(); const b = chat();
  registry.register(a.target); registry.register(b.target);
  expect(await registry.hotkey(true)).toBe(false);
  registry.focus(a.target); expect(await registry.hotkey(true)).toBe(true);
  registry.focus(b.target); expect(await registry.request(b.target)).toBe(false);
  expect(await registry.hotkey(false)).toBe(true);
  expect(a.target.toggle).toHaveBeenCalledTimes(2); expect(b.target.toggle).not.toHaveBeenCalled();
  expect(await registry.hotkey(true)).toBe(true); expect(b.target.toggle).toHaveBeenCalledOnce();
});
it('does not route to a hidden chat or start from another foreground application', async () => {
  const registry = new ManagedChatVoiceTargets(); const a = chat();
  registry.register(a.target); registry.focus(a.target);
  expect(await registry.hotkey(false)).toBe(false); a.hide();
  expect(await registry.hotkey(true)).toBe(false); expect(a.target.toggle).not.toHaveBeenCalled();
});
it('holds the lease during startup, closure and unknown outcomes even if the old composer unmounts', async () => {
  const registry = new ManagedChatVoiceTargets(); const a = chat(); const b = chat();
  const unregister = registry.register(a.target); registry.register(b.target);
  await registry.request(a.target); unregister();
  for (const state of ['connecting', 'closing', 'unknown'] as const) {
    a.phase(state); expect(await registry.request(b.target)).toBe(false);
  }
  expect(await registry.hotkey(true)).toBe(false);
  a.phase('closed'); expect(await registry.request(b.target)).toBe(true);
});

it('shares audio ownership with explicit standalone voice without treating it as the active chat', async () => {
  const registry = new ManagedChatVoiceTargets(); const a = chat(); const standalone = chat();
  standalone.target.standalone = true;
  registry.register(a.target); registry.focus(a.target);
  expect(await registry.request(standalone.target)).toBe(true);
  expect(await registry.hotkey(true)).toBe(false);
  expect(await registry.request(a.target)).toBe(false);
  expect(standalone.target.toggle).toHaveBeenCalledOnce();
  standalone.phase('closed');
  expect(await registry.hotkey(true)).toBe(true);
  expect(a.target.toggle).toHaveBeenCalledOnce();
});
