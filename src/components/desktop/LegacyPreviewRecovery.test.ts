// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createDefaultTileLayout } from '@/lib/tiles/operations';
import type { WorkspaceTerminalProps } from '@/components/desktop/workspace-terminal/types';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { createTileRegistry, type TileRegistryDeps } from '@/app/dashboard/tileRegistry';

vi.mock('@/lib/react/retrying-lazy', () => ({ retryingLazy: () => () => null }));

it.each([false, true])('recovers a saved Preview in the actual Browser without mounting the old iframe (populated: %s)', async populated => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const close = vi.fn(), openBrowser = vi.fn();
  const registry = createTileRegistry({
    workspacePreviews: populated ? [{ id: 'local', port: 61234, url: 'http://localhost:61234', tabId: 'shell', detectedAt: 1 }] : [],
    handleCloseTile: close, handleOpenBrowser: openBrowser,
  } as unknown as TileRegistryDeps);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    for (let repeat = 0; repeat < 3; repeat++) {
      await act(async () => root.render(registry.preview.render({ tileId: 'preview-owned', content: { kind: 'preview', selectedPreviewId: 'local' }, active: true })));
      expect(host.querySelector('iframe')).toBeNull();
      const closeButton = [...host.querySelectorAll('button')].find(button => button.textContent === 'Close preview')!;
      expect(closeButton).toBeDefined();
      await act(async () => { closeButton.focus(); closeButton.click(); });
      expect(document.activeElement).toBe(closeButton);
      expect(close).toHaveBeenLastCalledWith('preview-owned');
      expect(openBrowser).not.toHaveBeenCalled();
      await act(async () => root.render(null));
    }
    await act(async () => root.render(registry.preview.render({ tileId: 'preview-owned', content: { kind: 'preview' }, active: true })));
    const openButton = [...host.querySelectorAll('button')].find(button => button.textContent === 'Open in Browser')!;
    await act(async () => openButton.click());
    expect(openBrowser).toHaveBeenCalledExactlyOnceWith(populated ? 'http://localhost:61234' : undefined);
    expect(close).toHaveBeenCalledTimes(4);
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

it('routes a fresh terminal local-app announcement to the existing Browser opener', () => {
  const record = vi.fn(), openBrowser = vi.fn();
  const registry = createTileRegistry({
    workspacePreviews: [], workspaceScopeEntries: [], parsedAgents: [],
    workspaceTerminalResetNonceByTileId: {}, unverifiedRestoredRepoTileIds: new Set(),
    tileLayout: createDefaultTileLayout(), workspaceTerminalPreferredRepo: null,
    handlePreviewDetected: record, handleOpenBrowser: openBrowser,
  } as unknown as TileRegistryDeps);
  const tree = registry.terminal.render({ tileId: 'tile-root', content: { kind: 'terminal' }, active: true }) as ReactElement<{ children: ReactElement<WorkspaceTerminalProps> }>;
  const preview = { id: 'new-app', port: 61234, url: 'http://localhost:61234', tabId: 'shell', detectedAt: 1 };
  tree.props.children.props.onPreviewDetected?.(preview);
  expect(record).toHaveBeenCalledExactlyOnceWith(preview);
  expect(openBrowser).toHaveBeenCalledExactlyOnceWith(preview.url);
});
