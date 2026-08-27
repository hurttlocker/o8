/** @vitest-environment jsdom */
/* eslint-disable react-hooks/refs -- createElement passes the ref; it does not read it during render */

import { act, createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { useAgentVoiceMode } from './useAgentVoiceMode';

const mocks = vi.hoisted(() => ({
  fillInput: vi.fn(),
  play: vi.fn(async () => undefined),
  sendNow: vi.fn(() => true),
  setActiveComposer: vi.fn(),
  stop: vi.fn(),
}));

vi.mock('@/components/desktop/dictation/DictationHost', () => ({
  useDictationHostOptional: () => ({ setActiveComposer: mocks.setActiveComposer }),
}));

vi.mock('@/lib/tts/engine', () => ({
  ttsEngine: {
    state: { state: 'idle', activeMessageId: null },
    play: mocks.play,
    stop: mocks.stop,
  },
}));

let container: HTMLDivElement;
let root: Root;

function Harness({
  busy = false,
  messages = [],
  surfaceKey,
}: {
  busy?: boolean;
  messages?: MobileTranscriptEntry[];
  surfaceKey: string;
}) {
  const composerNodeRef = useRef<HTMLTextAreaElement>(null);
  const voiceMode = useAgentVoiceMode({
    active: true,
    busy,
    composerNodeRef,
    fillInput: mocks.fillInput,
    messages,
    sendNow: mocks.sendNow,
    surfaceKey,
  });
  return createElement('div', null,
    createElement('textarea', { ref: composerNodeRef }),
    createElement('button', {
      type: 'button',
      onClick: () => voiceMode.setEnabled(!voiceMode.enabled),
    }, voiceMode.enabled ? 'on' : 'off'),
  );
}

function activeDelivery(): (text: string) => void {
  const claim = [...mocks.setActiveComposer.mock.calls]
    .reverse()
    .find(([composer]) => composer !== null)?.[0] as { fill: (text: string) => void } | undefined;
  if (!claim) throw new Error('composer was not registered');
  return claim.fill;
}

function entry(id: string, role: 'user' | 'assistant', text: string): MobileTranscriptEntry {
  return { id, role, text };
}

describe('useAgentVoiceMode', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
  });

  it('keeps dictation as a draft until the operator explicitly enables voice mode', () => {
    act(() => root.render(createElement(Harness, { surfaceKey: 'draft-test' })));

    act(() => activeDelivery()('draft only'));
    expect(mocks.fillInput).toHaveBeenCalledWith('draft only');
    expect(mocks.sendNow).not.toHaveBeenCalled();

    const toggle = container.querySelector('button');
    act(() => toggle?.click());
    act(() => activeDelivery()('send aloud'));

    expect(mocks.sendNow).toHaveBeenCalledWith('send aloud');
    expect(localStorage.getItem('o8:agent-voice-mode:v1:draft-test')).toBe('true');
  });

  it('plays one complete assistant reply after the active voice turn settles', () => {
    localStorage.setItem('o8:agent-voice-mode:v1:playback-test', 'true');
    act(() => root.render(createElement(Harness, { surfaceKey: 'playback-test' })));
    act(() => root.render(createElement(Harness, {
      surfaceKey: 'playback-test',
      busy: true,
      messages: [entry('u1', 'user', 'question'), entry('a1', 'assistant', 'partial')],
    })));
    expect(mocks.play).not.toHaveBeenCalled();

    act(() => root.render(createElement(Harness, {
      surfaceKey: 'playback-test',
      messages: [entry('u1', 'user', 'question'), entry('a1', 'assistant', 'complete answer')],
    })));

    expect(mocks.play).toHaveBeenCalledOnce();
    expect(mocks.play).toHaveBeenCalledWith(
      'complete answer',
      'voice-mode:playback-test:a1',
    );
  });
});
