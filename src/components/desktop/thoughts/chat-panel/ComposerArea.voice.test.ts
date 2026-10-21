/** @vitest-environment jsdom */
import { act, createElement, useState, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ComposerArea } from './ComposerArea';
import { ManagedLiveButton } from './ManagedLiveButton';
import { DictationHost } from '../../dictation/DictationHost';
import type { DictationStartOptions, DictationState } from '../../dictation/types';

const fixture = vi.hoisted(() => ({ state: 'idle' as DictationState, options: null as DictationStartOptions | null,
  start: vi.fn(async (options: DictationStartOptions) => { fixture.options = options; fixture.state = 'recording'; }),
  cancel: vi.fn(() => { fixture.state = 'idle'; }), stopAndSubmit: vi.fn(), play: vi.fn(async () => {}), stop: vi.fn() }));
vi.mock('../../dictation/useDictation', () => ({ useDictation: () => ({ ...fixture, snapshot: { state: fixture.state, audioLevel: 0, durationMs: 0, error: null, partialTranscript: '' } }) }));
vi.mock('../../dictation/useNativeDictation', () => ({ isNativeDictationAvailable: () => false, useNativeDictation: () => ({ ...fixture, snapshot: { state: fixture.state } }) }));
vi.mock('../../dictation/DictationPill', () => ({ DictationPill: () => null }));
vi.mock('../../dictation/useSymonEditBridge', () => ({ useSymonEditBridge: () => {} }));
vi.mock('@/lib/tauri/bridge', () => ({ canUseTauriEvents: () => false, isTauri: () => false }));
vi.mock('@/lib/tts/dictation-barge-in', () => ({ stopPlaybackForDictation: vi.fn() }));
vi.mock('@/lib/tts/engine', () => ({ ttsEngine: { state: {}, stop: fixture.stop, playNoKey: fixture.play } }));
vi.mock('../InputButtons', async () => {
  const { MicButton } = await import('../MicButton');
  return { RepoTargetChip: () => null, InputButtons: (props: { managedVoiceControl?: unknown }) => createElement('div', null, createElement(MicButton), props.managedVoiceControl as never) };
});
vi.mock('./SlashCommandPicker', () => ({ SlashCommandPicker: () => null }));
vi.mock('./ComposerStatusBar', () => ({ ComposerStatusBar: () => null }));
vi.mock('../../composer-center-registry', () => ({ registerComposerCenter: () => () => {} }));
let root: Root; let container: HTMLDivElement;
const send = vi.fn(() => ({ userMessageId: 'accepted-turn' }));
function Harness({ binding = 'one', terminals = {} }: { binding?: string; terminals?: ComponentProps<typeof ManagedLiveButton>['terminals'] }) {
  const [input, setInput] = useState('');
  return createElement(DictationHost, null, createElement(ComposerArea, {
    activeComposer: true, dictationScopeKey: binding, showBrain: false, input, onInputChange: setInput,
    isOrchestratorMode: true, displayWaiting: false, chatMessages: [], activeTargetLabel: 'CLI', targetAgentExists: true,
    thoughtsBodyBackground: 'var(--t-workspace)', enhancing: false, preEnhanceInput: null,
    onEnhance: () => {}, onUndoEnhance: () => {}, onSubmit: () => {}, onSlashCommand: () => {},
    modelLabel: 'Selected CLI', effort: 'high', onEffortChange: () => {}, adaptiveEnabled: false,
    displayMessagesCount: 0, hasAssistantActivity: false,
    voiceControl: createElement(ManagedLiveButton, { binding, busy: false, messages: [], terminals, send, interrupt: () => {} }),
  }));
}
const render = (props: ComponentProps<typeof Harness> = {}) => act(() => root.render(createElement(Harness, props)));
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); fixture.state = 'idle'; fixture.options = null;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ enabled: false, entitled: false, byokAvailable: false })));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('keeps normal dictation in the draft and sends only after explicit mode choice through the existing composer owner', async () => {
  await act(async () => render());
  const mic = container.querySelector('button')!;
  await act(async () => mic.click());
  act(() => fixture.options!.onComplete('Draft only'));
  expect(container.querySelector('textarea')!.value).toBe('Draft only'); expect(send).not.toHaveBeenCalled();
  fixture.state = 'idle'; render();
  await act(async () => container.querySelector('button[aria-haspopup="dialog"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  const start = Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Start turn-by-turn')!;
  expect(start.disabled).toBe(false); await act(async () => start.click());
  act(() => fixture.options!.onComplete('Send this turn'));
  expect(send).toHaveBeenCalledExactlyOnceWith('Send this turn');
  expect(container.querySelector('textarea')!.value).toBe('Draft only');
  render({ terminals: { 'accepted-turn': { outcome: 'unconfirmed', text: 'partial' } } }); expect(fixture.play).not.toHaveBeenCalled();
  render({ terminals: { 'accepted-turn': { outcome: 'completed', text: 'Confirmed result' } } });
  expect(fixture.play).toHaveBeenCalledExactlyOnceWith('Confirmed result', 'turn-voice:one:accepted-turn');
});
it('cancels only its owned recording on chat change and drops the old engine completion', async () => {
  await act(async () => render());
  await act(async () => container.querySelector('button[aria-haspopup="dialog"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  const start = Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Start turn-by-turn')!;
  await act(async () => start.click()); const old = fixture.options!;
  render({ binding: 'two' }); act(() => old.onComplete('Late words'));
  expect(fixture.cancel).toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  expect(container.querySelector('textarea')!.value).toBe('');
});
