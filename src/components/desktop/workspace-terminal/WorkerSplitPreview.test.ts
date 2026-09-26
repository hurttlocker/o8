// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultSessionTileLayout } from '@/lib/orchestrator/session-tiles';
import { WorkerSplitPreview } from './WorkerSplitPreview';

vi.mock('@/components/desktop/SessionTranscriptPane', () => ({
  SessionTranscriptPane: () => { throw new Error('A preview worker reached the real transcript'); },
}));

vi.mock('@/components/desktop/workspace-terminal/LiveSessionMesh', () => ({
  projectLiveSessionMeshParticipants: () => [],
}));

vi.mock('@/components/desktop/workspace-terminal/ThreadChatPane', () => ({
  ThreadChatPane: () => null,
}));

describe('native worker split preview', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it('spawns four or ten simulated panes and returns to live data without touching a transcript', async () => {
    await act(async () => root.render(createElement(WorkerSplitPreview, {
      layout: createDefaultSessionTileLayout(),
      focusedSessionKey: null,
      chatSlot: createElement('div', { 'data-real-chat': true }, 'Real orchestrator chat'),
      onResizeSplit: vi.fn(),
      onCloseLeaf: vi.fn(),
      onFocusSession: vi.fn(),
    })));
    const chat = host.querySelector('[data-real-chat]');
    await act(async () => host.querySelector<HTMLButtonElement>('[data-worker-split-preview-launch]')!.click());
    await act(async () => vi.advanceTimersByTime(4 * 180));
    expect(host.querySelectorAll('[data-real-chat]')).toHaveLength(1);
    expect(host.querySelector('[data-real-chat]')).toBe(chat);
    expect(host.querySelectorAll('[data-preview-worker]')).toHaveLength(4);
    expect(host.querySelectorAll('[data-session-resize-handle]')).toHaveLength(4);

    await act(async () => host.querySelector<HTMLButtonElement>('[data-worker-split-preview] button:nth-of-type(2)')!.click());
    await act(async () => vi.advanceTimersByTime(10 * 180));
    expect(host.querySelectorAll('[data-preview-worker]')).toHaveLength(10);
    expect(host.querySelectorAll('[data-session-resize-handle]')).toHaveLength(10);
    expect(host.querySelector('[data-real-chat]')).toBe(chat);

    await act(async () => host.querySelector<HTMLButtonElement>('[data-worker-split-preview] button:nth-of-type(3)')!.click());
    expect(host.querySelector('[data-worker-split-preview]')).toBeNull();
    expect(host.querySelector('[data-worker-split-preview-launch]')).not.toBeNull();
  });
});
