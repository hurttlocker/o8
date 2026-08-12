// @vitest-environment jsdom

import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addSessionToLayout,
  collectSessionLeaves,
  createDefaultSessionTileLayout,
  splitSessionWithSession,
  type SessionTileNode,
  type SessionTileSplit,
} from '@/lib/orchestrator/session-tiles';
import { SessionTileSurface } from './SessionTileSurface';

vi.mock('@/components/desktop/SessionTranscriptPane', async () => {
  const React = await import('react');
  return {
    SessionTranscriptPane: ({ sessionKey }: { sessionKey: string }) => (
      React.createElement('div', { 'data-manual-transcript': sessionKey }, sessionKey)
    ),
  };
});

vi.mock('@/components/desktop/workspace-terminal/LiveSessionMesh', async () => {
  const React = await import('react');
  return {
    ConnectedLiveSessionMesh: () => React.createElement('div', { 'data-mocked-mesh': true }),
    projectLiveSessionMeshParticipants: () => [],
  };
});

vi.mock('@/components/desktop/workspace-terminal/ThreadChatPane', async () => {
  const React = await import('react');
  return { ThreadChatPane: () => React.createElement('div') };
});

function findSplit(node: SessionTileNode, direction: 'horizontal' | 'vertical'): SessionTileSplit | null {
  if (node.type === 'leaf') return null;
  if (node.direction === direction) return node;
  return findSplit(node.children[0], direction) ?? findSplit(node.children[1], direction);
}

describe('SessionTileSurface manual split geometry', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('mounts explicit session splits as independent panes with authored ratio and resize handle', async () => {
    let layout = addSessionToLayout(createDefaultSessionTileLayout(), 'automatic:one');
    const first = collectSessionLeaves(layout.root)[0];
    expect(first).toBeTruthy();
    if (!first) return;
    layout = splitSessionWithSession(layout, first.id, 'manual:two', 'horizontal', 0.65);
    const authored = findSplit(layout.root, 'horizontal');
    expect(authored?.ratio).toBe(0.65);
    const onResizeSplit = vi.fn();

    await act(async () => {
      root.render(createElement(SessionTileSurface, {
        layout,
        focusedSessionKey: 'manual:two',
        chatSlot: createElement('div', { 'data-chat-slot': true }),
        onResizeSplit,
        onCloseLeaf: vi.fn(),
        onFocusSession: vi.fn(),
      }));
    });

    expect(host.querySelectorAll('[data-live-session-mesh-region]')).toHaveLength(0);
    expect(host.querySelectorAll('[data-mocked-mesh]')).toHaveLength(0);
    expect(host.querySelectorAll('[data-manual-transcript]')).toHaveLength(2);
    const horizontalHandle = host.querySelector<HTMLElement>('[data-session-resize-direction="horizontal"]');
    expect(horizontalHandle?.getAttribute('data-session-resize-handle')).toBe(authored?.id);
    expect(horizontalHandle?.style.top).toBe('calc(65% - 4px)');
    const surface = host.querySelector<HTMLElement>('[data-session-tile-surface]');
    if (!surface || !horizontalHandle || !authored) return;
    surface.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 800,
      width: 1000,
      height: 800,
      toJSON: () => ({}),
    });

    await act(async () => {
      horizontalHandle.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        clientX: 700,
        clientY: 520,
      }));
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 700, clientY: 600 }));
      document.dispatchEvent(new MouseEvent('mouseup'));
    });
    expect(onResizeSplit).toHaveBeenLastCalledWith(authored.id, 0.75);
  });
});
