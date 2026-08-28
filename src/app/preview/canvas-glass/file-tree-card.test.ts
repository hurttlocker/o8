// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileTreeGlassCard, type FileTreeCard } from './file-tree-card';

vi.mock('./card-shell', () => ({
  GlassCardShell: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));
vi.mock('./use-scroll-blur-fade', () => ({ useScrollBlurFade: vi.fn() }));

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

const card: FileTreeCard = {
  id: 7,
  x: 100,
  y: 80,
  z: 12,
  w: 400,
  h: 460,
  repoPath: '/repo',
};

const callbacks = {
  onMove: vi.fn(),
  onResize: vi.fn(),
  onFocus: vi.fn(),
  onClose: vi.fn(),
};

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('FileTreeGlassCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('loads the root, lazily expands a directory, and opens a full file path beside the tree', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        entries: [
          { name: 'src', path: 'src', kind: 'directory' },
          { name: 'node_modules', path: 'node_modules', kind: 'directory', ignored: true },
          { name: 'README.md', path: 'README.md', kind: 'file' },
        ],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        entries: [{ name: 'index.ts', path: 'src/index.ts', kind: 'file' }],
      }), { status: 200 }));
    const spawnFileCard = vi.fn();

    act(() => root.render(createElement(FileTreeGlassCard, {
      card,
      spawnFileCard,
      fetchImpl,
      ...callbacks,
    })));
    await flushEffects();

    expect(container.querySelector('[data-file-tree-path="README.md"]')).not.toBeNull();
    const ignored = container.querySelector<HTMLButtonElement>('[data-file-tree-path="node_modules"]');
    expect(ignored?.getAttribute('aria-expanded')).toBe('false');
    expect(fetchImpl).toHaveBeenCalledOnce();

    const source = container.querySelector<HTMLButtonElement>('[data-file-tree-path="src"]');
    act(() => source?.click());
    await flushEffects();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-file-tree-path="src/index.ts"]')).not.toBeNull();
    expect(ignored?.getAttribute('aria-expanded')).toBe('false');

    const file = container.querySelector<HTMLButtonElement>('[data-file-tree-path="src/index.ts"]');
    act(() => file?.click());
    expect(spawnFileCard).toHaveBeenCalledOnce();
    expect(spawnFileCard).toHaveBeenCalledWith('/repo/src/index.ts', {
      x: 528,
      y: 80,
      w: 620,
      h: 420,
    }, '/repo');
  });
});
