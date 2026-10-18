/** @vitest-environment jsdom */
/* eslint-disable react-hooks/refs -- createElement passes the textarea ref without reading it */
import { act, createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DictationHost } from './DictationHost';
import { ComposerDictationContext } from './ComposerDictation';
import { MicButton } from '../thoughts/MicButton';
import { CardComposer } from '@/app/preview/canvas-glass/card-composer';
import { useAgentVoiceMode } from '../thoughts/chat-panel/useAgentVoiceMode';
import type { DictationStartOptions, DictationState } from './types';

const engine = vi.hoisted(() => ({
  state: 'idle' as DictationState,
  options: null as DictationStartOptions | null,
  start: vi.fn(async (options: DictationStartOptions) => { engine.options = options; engine.state = 'recording'; }),
  stopAndSubmit: vi.fn(), cancel: vi.fn(() => { engine.state = 'idle'; }),
}));
vi.mock('./useDictation', () => ({ useDictation: () => ({ ...engine, snapshot: { state: engine.state, audioLevel: 0, durationMs: 0, error: null, partialTranscript: '' } }) }));
vi.mock('./useNativeDictation', () => ({ isNativeDictationAvailable: () => false, useNativeDictation: () => ({ ...engine, snapshot: { state: engine.state } }) }));
vi.mock('./DictationPill', () => ({ DictationPill: () => null }));
vi.mock('./useSymonEditBridge', () => ({ useSymonEditBridge: () => undefined }));
vi.mock('@/lib/tauri/bridge', () => ({ canUseTauriEvents: () => false }));
vi.mock('@/lib/tts/dictation-barge-in', () => ({ stopPlaybackForDictation: vi.fn() }));
vi.mock('@/lib/tts/engine', () => ({ ttsEngine: { state: {}, stop: vi.fn(), play: vi.fn() } }));

let root: Root;
let container: HTMLDivElement;
const fillA = vi.fn();
const fillB = vi.fn();
function Composer({ id, fill }: { id: string; fill: (text: string) => void }) {
  const node = useRef<HTMLTextAreaElement>(null);
  const { dictationId } = useAgentVoiceMode({ active: true, dictationOnly: true, busy: false, composerNodeRef: node, fillInput: fill,
    messages: [], sendNow: () => false, surfaceKey: id });
  return createElement(ComposerDictationContext.Provider, { value: dictationId },
    createElement('div', { 'data-o8-composer-root': '', 'data-id': id },
      createElement('textarea', { ref: node }), createElement(MicButton)));
}
function render(showA = true, scopeA = 'a') {
  act(() => root.render(createElement(DictationHost, null,
    showA ? createElement(Composer, { key: 'a', id: scopeA, fill: fillA }) : null,
    createElement(Composer, { key: 'b', id: 'b', fill: fillB }))));
}
const button = (id: string) => container.querySelector(`[data-id="${id}"] button`) as HTMLButtonElement;
const field = (id: string) => container.querySelector(`[data-id="${id}"] textarea`) as HTMLTextAreaElement;

describe('composer dictation ownership', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks(); engine.state = 'idle'; engine.options = null;
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });
  it('marks only the composer that started recording', () => {
    render(); act(() => field('a').focus()); act(() => button('a').click()); render();
    expect(button('a').title).toBe('Click to send');
    expect(button('b').title).not.toBe('Click to send');
  });
  it('delivers to its original composer after focus changes', () => {
    render(); act(() => field('a').focus()); act(() => button('a').click()); render();
    act(() => field('b').focus());
    act(() => engine.options?.onComplete('original destination'));
    expect(fillA).toHaveBeenCalledWith('original destination'); expect(fillB).not.toHaveBeenCalled();
  });
  it('does not let another composer stop the active recording', () => {
    render(); act(() => field('a').focus()); act(() => button('a').click()); render();
    act(() => button('b').click()); expect(engine.stopAndSubmit).not.toHaveBeenCalled();
  });
  it('cancels when the owning composer closes and ignores its late result', () => {
    render(); act(() => field('a').focus()); act(() => button('a').click()); render(false);
    act(() => engine.options?.onComplete('late result'));
    expect(engine.cancel).toHaveBeenCalled(); expect(fillA).not.toHaveBeenCalled(); expect(fillB).not.toHaveBeenCalled();
  });
  it('starts in the clicked composer without requiring textarea focus', () => {
    render(); act(() => field('b').focus()); act(() => button('a').click()); render();
    act(() => engine.options?.onComplete('clicked destination'));
    expect(fillA).toHaveBeenCalledWith('clicked destination'); expect(fillB).not.toHaveBeenCalled();
  });
  it('keeps the owner when another composer unmounts', () => {
    render(); act(() => button('b').click()); render(false);
    act(() => engine.options?.onComplete('still owned'));
    expect(fillB).toHaveBeenCalledWith('still owned'); expect(engine.cancel).not.toHaveBeenCalled();
  });
  it('keeps keyboard hold state across the recording render', () => {
    render(); act(() => field('a').focus());
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true })));
    render(); expect(button('a').title).toBe('Click to send');
    act(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'z', ctrlKey: true })));
    expect(engine.stopAndSubmit).toHaveBeenCalledOnce();
  });
  it('cancels keyboard startup when the key is released before permission resolves', async () => {
    let finish!: () => void;
    engine.start.mockImplementationOnce(options => {
      engine.options = options; engine.state = 'requesting-mic';
      return new Promise<void>(resolve => { finish = () => { engine.state = 'recording'; resolve(); }; });
    });
    render(); act(() => field('a').focus());
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true })));
    render();
    act(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'z', ctrlKey: true })));
    await act(async () => { finish(); await Promise.resolve(); });
    expect(engine.state).toBe('idle'); expect(engine.stopAndSubmit).not.toHaveBeenCalled();
    act(() => engine.options?.onComplete('released before recording'));
    expect(fillA).not.toHaveBeenCalled();
  });

  it('preserves a canvas recording when only its placeholder changes', () => {
    const draw = (placeholder: string) => act(() => root.render(createElement(DictationHost, null,
      createElement(CardComposer, { scopeKey: 'same-conversation', placeholder, value: '', onChange: fillA, onSubmit: () => {} }))));
    draw('Queue a follow-up…');
    act(() => (container.querySelector('button') as HTMLButtonElement).click());
    draw('Reply to conversation');
    act(() => engine.options?.onComplete('same destination'));
    expect(fillA).toHaveBeenCalledWith('same destination'); expect(engine.cancel).not.toHaveBeenCalled();
  });

  it('revokes startup that finishes after the owner closes', async () => {
    let finish!: () => void;
    engine.start.mockImplementationOnce(options => {
      engine.options = options;
      return new Promise<void>(resolve => { finish = () => { engine.state = 'recording'; resolve(); }; });
    });
    render(); act(() => button('a').click()); render(false);
    await act(async () => { finish(); await Promise.resolve(); });
    render(false);
    expect(engine.state).toBe('idle');
    act(() => engine.options?.onComplete('late microphone'));
    expect(fillA).not.toHaveBeenCalled(); expect(fillB).not.toHaveBeenCalled();
  });

  it('does not let a released old keyboard hold stop a replacement recording', async () => {
    render(); act(() => field('a').focus());
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true })); });
    render(false);
    await act(async () => { button('b').click(); });
    render(false);
    expect(button('b').title).toBe('Click to send');
    act(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'z', ctrlKey: true })));
    expect(engine.stopAndSubmit).not.toHaveBeenCalled();
  });

  it('rejects the old result after the same pane changes conversations', () => {
    render(); act(() => button('a').click()); render(true, 'replacement');
    act(() => engine.options?.onComplete('old conversation'));
    expect(engine.cancel).toHaveBeenCalled(); expect(fillA).not.toHaveBeenCalled(); expect(fillB).not.toHaveBeenCalled();
  });

});
