/** @vitest-environment jsdom */

import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listPromptStash } from '@/lib/orchestrator/prompt-stash';
import { ComposerArea } from './ComposerArea';

vi.mock('../InputButtons', () => ({
  InputButtons: () => null,
}));

vi.mock('./SlashCommandPicker', () => ({
  SlashCommandPicker: () => null,
}));

vi.mock('./ComposerStatusBar', () => ({
  ComposerStatusBar: () => null,
}));

vi.mock('../../composer-center-registry', () => ({
  registerComposerCenter: () => () => undefined,
}));

let container: HTMLDivElement;
let root: Root;

function Harness() {
  const [input, setInput] = useState('Park this prompt while I fix CI');

  return createElement(ComposerArea, {
    activeComposer: true,
    input,
    onInputChange: setInput,
    isOrchestratorMode: true,
    displayWaiting: false,
    chatMessages: [],
    activeTargetLabel: 'Orchestrator',
    targetAgentExists: true,
    thoughtsBodyBackground: 'var(--t-workspace)',
    enhancing: false,
    preEnhanceInput: null,
    onEnhance: () => undefined,
    onUndoEnhance: () => undefined,
    onSubmit: () => undefined,
    onSlashCommand: () => undefined,
    modelLabel: 'Codex',
    effort: 'max',
    onEffortChange: () => undefined,
    adaptiveEnabled: false,
    displayMessagesCount: 0,
    hasAssistantActivity: false,
    promptStash: {
      repoPath: '/Users/operator/o8',
      threadId: 'thread-7',
      onRestore: () => undefined,
    },
  });
}

describe('ComposerArea prompt stash chord', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
  });

  it('stashes composer text through the real Cmd+Shift+S keydown path and clears the input', () => {
    act(() => root.render(createElement(Harness)));
    const textarea = container.querySelector('textarea');
    expect(textarea).not.toBeNull();

    const event = new KeyboardEvent('keydown', {
      key: 's',
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => textarea?.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    expect(listPromptStash()).toEqual([
      expect.objectContaining({
        text: 'Park this prompt while I fix CI',
        repoPath: '/Users/operator/o8',
        threadId: 'thread-7',
      }),
    ]);
    expect(textarea?.value).toBe('');
  });
});
