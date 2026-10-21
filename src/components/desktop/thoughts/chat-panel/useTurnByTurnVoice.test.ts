/** @vitest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ComposerVoiceTurnContext, type ComposerVoiceTurnTarget } from './ComposerVoiceTurnContext';
import { useTurnByTurnVoice } from './useTurnByTurnVoice';

const fixture = vi.hoisted(() => ({ ownerId: null as string | null, snapshotState: 'idle', start: vi.fn(async () => {}), cancel: vi.fn(), stopAndSubmit: vi.fn(), play: vi.fn(async () => {}), stop: vi.fn(), activeMessageId: null as string | null }));
vi.mock('@/components/desktop/dictation/DictationHost', () => ({ useDictationHostOptional: () => fixture }));
vi.mock('@/lib/tts/engine', () => ({ ttsEngine: { playNoKey: fixture.play, stop: fixture.stop, get state() { return { activeMessageId: fixture.activeMessageId }; } } }));
let root: Root; let container: HTMLDivElement;
const send = vi.fn(() => ({ userMessageId: 'owned-turn' }));
let intercept: ((text: string) => boolean) | null;
const target: ComposerVoiceTurnTarget = { dictationId: 'composer-one', intercept: handler => { intercept = handler; return () => { if (intercept === handler) intercept = null; }; } };
type Terminals = Record<string, { outcome: 'completed' | 'failed' | 'interrupted' | 'unconfirmed'; text: string }>;
function Harness({ binding = 'one', terminals = {}, busy = false }: { binding?: string; terminals?: Terminals; busy?: boolean }) {
  const voice = useTurnByTurnVoice({ binding, terminals, send, busy });
  return createElement('button', { onClick: () => { void (voice.enabled ? voice.stop() : voice.start()); } }, voice.enabled ? 'Stop' : 'Start');
}
function render(props: Parameters<typeof Harness>[0] = {}) { act(() => root.render(createElement(ComposerVoiceTurnContext.Provider, { value: target }, createElement(Harness, props)))); }
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); intercept = null; fixture.ownerId = null; fixture.snapshotState = 'idle'; fixture.activeMessageId = null;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
it('leaves ordinary dictation draft-only, then explicitly starts one owned turn and reads its terminal receipt once', async () => {
  render(); expect(intercept).toBeNull(); expect(fixture.start).not.toHaveBeenCalled();
  await act(async () => container.querySelector('button')!.click());
  expect(fixture.start).toHaveBeenCalledWith(expect.objectContaining({ surface: 'orchestrator' }), 'composer-one');
  act(() => { expect(intercept!('do this')).toBe(true); });
  expect(send).toHaveBeenCalledExactlyOnceWith('do this');
  render({ terminals: { other: { outcome: 'completed', text: 'Old result' }, 'owned-turn': { outcome: 'unconfirmed', text: 'Partial' } } });
  expect(fixture.play).not.toHaveBeenCalled();
  render({ busy: false }); expect(fixture.play).not.toHaveBeenCalled();
  const terminals: Terminals = { 'owned-turn': { outcome: 'completed', text: 'Actual result' } };
  render({ terminals }); render({ terminals: { ...terminals } });
  expect(fixture.play).toHaveBeenCalledExactlyOnceWith('Actual result', expect.stringContaining('owned-turn'));
});
it('refuses duplicate sends while its correlated turn is pending', async () => {
  render(); await act(async () => container.querySelector('button')!.click());
  act(() => { intercept!('first'); intercept!('second'); });
  expect(send).toHaveBeenCalledOnce();
});
it('stops only its own recording and playback and ignores receipts after stop or a binding switch', async () => {
  render(); await act(async () => container.querySelector('button')!.click());
  act(() => { intercept!('request'); });
  fixture.ownerId = 'composer-one'; fixture.activeMessageId = 'turn-voice:one:owned-turn';
  await act(async () => container.querySelector('button')!.click());
  expect(fixture.cancel).toHaveBeenCalledWith('composer-one'); expect(fixture.stop).toHaveBeenCalledOnce(); expect(intercept).toBeNull();
  render({ binding: 'two', terminals: { 'owned-turn': { outcome: 'completed', text: 'Late old result' } } });
  expect(fixture.play).not.toHaveBeenCalled(); expect(container.textContent).toBe('Start');
});
it('does not cancel another composer or unrelated playback on unmount', async () => {
  render(); await act(async () => container.querySelector('button')!.click());
  fixture.ownerId = 'other'; fixture.activeMessageId = 'message-reading';
  act(() => root.render(null));
  expect(fixture.cancel).not.toHaveBeenCalled(); expect(fixture.stop).not.toHaveBeenCalled();
});
