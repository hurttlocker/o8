// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandPaletteActionItem, CommandPaletteFileItem } from '@/components/desktop/CommandPalette';
import type { CanvasCommands } from './canvas-commands';
import { CanvasCommandPalette } from './canvas-command-palette';

vi.mock('@/components/desktop/CommandPalette', () => ({
  CommandPalette: ({
    open,
    onClose,
    actionItems,
    initialScope,
    fileItems,
    onSelectFile,
  }: {
    open: boolean;
    onClose: () => void;
    actionItems: CommandPaletteActionItem[];
    initialScope?: 'all' | 'file';
    fileItems?: CommandPaletteFileItem[];
    onSelectFile: (path: string) => void;
  }): ReactNode => {
    if (!open) return null;
    return createElement(
      'div',
      { 'data-canvas-palette': 'open', 'data-palette-scope': initialScope },
      ...actionItems.map((item) => createElement(
        'button',
        {
          key: item.id,
          type: 'button',
          onClick: () => {
            item.onActivate();
            onClose();
          },
        },
        item.title,
      )),
      ...(fileItems ?? []).map((item) => createElement(
        'button',
        { key: item.path, type: 'button', onClick: () => { onSelectFile(item.path); onClose(); } },
        item.title ?? item.path,
      )),
    );
  },
}));

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

function createCommands(spawnFile: CanvasCommands['spawnFile']): CanvasCommands {
  return {
    spawnTerminal: vi.fn(),
    spawnFile,
    spawnTree: vi.fn(),
    spawnImage: vi.fn(),
    spawnVideo: vi.fn(),
    spawnBrowser: vi.fn(),
    spawnChat: vi.fn(),
    spawnDiff: vi.fn(),
    spawnSpec: vi.fn(),
    spawnBrain: vi.fn(),
    spawnMarkdown: vi.fn(),
    spawnAgent: vi.fn(),
    openSearch: vi.fn(),
    closeActiveCard: vi.fn(),
    zoomIn: vi.fn(),
    zoomToFit: vi.fn(),
    zoomOut: vi.fn(),
  };
}

describe('CanvasCommandPalette', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('opens on Command-K and activates the file-card command', async () => {
    const spawnFile = vi.fn();
    act(() => root.render(createElement(CanvasCommandPalette, { commands: createCommands(spawnFile) })));

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'k',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }));
      await Promise.resolve();
    });
    expect(container.querySelector('[data-canvas-palette="open"]')).not.toBeNull();
    expect(container.querySelector('[data-palette-scope="all"]')).not.toBeNull();

    const button = Array.from(container.querySelectorAll('button')).find((entry) => entry.textContent === 'New file card');
    expect(button).toBeDefined();
    act(() => button?.click());

    expect(spawnFile).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-canvas-palette="open"]')).toBeNull();
  });

  it('opens file mode on Command-P, refreshes the active repo, and opens one listed file', async () => {
    const spawnFile = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      entries: [{ name: 'page.tsx', path: 'src/app/page.tsx', kind: 'file' }],
      root: '/repo',
    }), { status: 200 }));
    act(() => root.render(createElement(CanvasCommandPalette, {
      commands: createCommands(spawnFile),
      repo: '/repo',
      fetchImpl,
    })));

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'p',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-palette-scope="file"]')).not.toBeNull();
    expect(fetchImpl).toHaveBeenCalledOnce();
    const button = Array.from(container.querySelectorAll('button')).find((entry) => entry.textContent === 'page.tsx');
    expect(button).toBeDefined();
    act(() => button?.click());

    expect(spawnFile).toHaveBeenCalledOnce();
    expect(spawnFile).toHaveBeenCalledWith('/repo/src/app/page.tsx');
  });
});
