// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceHeaderStrip } from './WorkspaceHeaderStrip';
import type { WorkspaceHeaderStripProps } from './workspace-header-strip-types';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// The strip observes its scroller for overflow affordances; jsdom has neither.
vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
});

function headerTab(index: number, label: string) {
  return {
    id: `tab-${index}`,
    label,
    kind: 'orchestrator',
    runtime: null,
    packetStatus: null,
  };
}

function stripProps(overrides: Partial<WorkspaceHeaderStripProps> = {}): WorkspaceHeaderStripProps {
  return {
    headerTabs: [
      headerTab(0, 'Fix the tab strip'),
      headerTab(1, 'Rename me later'),
      headerTab(2, 'Third session'),
    ],
    headerActiveTabId: 'tab-1',
    workspaceId: 'ws-1',
    ...overrides,
  };
}

describe('WorkspaceHeaderStrip session tabs (#2146)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('exposes the pill strip as a tablist of tabs with aria-selected', async () => {
    await act(async () => root.render(createElement(WorkspaceHeaderStrip, stripProps())));

    const tablist = container.querySelector('[role="tablist"]');
    expect(tablist).not.toBeNull();
    expect(tablist?.getAttribute('aria-orientation')).toBe('horizontal');

    const tabs = Array.from(tablist!.querySelectorAll('[role="tab"]'));
    expect(tabs).toHaveLength(3);
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
  });

  it('renames a workspace tab without changing its identity or pane selection', async () => {
    const renames: Array<{ tabId: string; label: string; workspaceId: string }> = [];
    const onRename = (event: Event) => {
      renames.push((event as CustomEvent<{ tabId: string; label: string; workspaceId: string }>).detail);
    };
    window.addEventListener('o8:request-rename-tab', onRename);
    try {
      await act(async () => root.render(createElement(WorkspaceHeaderStrip, stripProps({ tabWorkspaceId: 'primary-owner' }))));
      const tab = container.querySelector<HTMLElement>('[data-o8-workspace-tab="tab-1"]')!;
      await act(async () => tab.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
      const input = container.querySelector<HTMLInputElement>('input[aria-label="Rename Rename me later"]')!;
      expect(input).not.toBeNull();
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'My research desk');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
      expect(renames).toEqual([{ tabId: 'tab-1', label: 'My research desk', workspaceId: 'primary-owner' }]);
      expect(tab.getAttribute('aria-selected')).toBe('true');
    } finally {
      window.removeEventListener('o8:request-rename-tab', onRename);
    }
  });

  it('keeps the bottom panel action separate from a new terminal pane', async () => {
    const toggleBottomPanel = vi.fn();
    const splits: Array<{ kind: string; direction: string; workspaceId: string }> = [];
    const onSplit = (event: Event) => {
      splits.push((event as CustomEvent<{ kind: string; direction: string; workspaceId: string }>).detail);
    };
    window.addEventListener('o8:request-split-workspace-tab', onSplit);
    try {
      await act(async () => root.render(createElement(WorkspaceHeaderStrip, stripProps({
        onToggleBottomPanel: toggleBottomPanel,
      }))));
      expect(container.querySelector('button[aria-label="Choose bottom panel surface"]')).toBeNull();
      await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Open bottom panel"]')?.click());
      expect(toggleBottomPanel).toHaveBeenCalledOnce();
      expect(splits).toEqual([]);

      await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Add pane (workspace)"]')?.click());
      const menu = document.querySelector('[role="menu"][aria-label="Add pane options (workspace)"]');
      expect(menu).not.toBeNull();
      const items = Array.from(menu!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
      await act(async () => items.find((item) => item.textContent === 'Terminal')?.click());
      expect(splits).toEqual([{ kind: 'terminal', direction: 'right', workspaceId: 'ws-1' }]);
      expect(toggleBottomPanel).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener('o8:request-split-workspace-tab', onSplit);
    }
  });

  it.each([2, 4])('keeps one Add and no Close in the top header for %i panes', async (count) => {
    await act(async () => root.render(createElement(WorkspaceHeaderStrip, stripProps({
      paneCount: count,
      tabWorkspaceId: 'primary-session-owner',
    }))));
    expect(container.querySelectorAll('button[aria-label="Add pane (workspace)"]')).toHaveLength(1);
    expect(container.querySelector('button[aria-label="Show pane grid"]')).toBeNull();
    expect(container.textContent).toContain(`${count} panes`);
    expect(container.querySelector('button[aria-label^="Close pane"]')).toBeNull();
    expect(container.querySelectorAll('[role="tablist"] [role="tab"]')).toHaveLength(3);
  });

  it('routes top page tabs to their owner while Add targets the active pane', async () => {
    const selections: Array<{ tabId: string; workspaceId: string }> = [];
    const onSelect = (event: Event) => selections.push((event as CustomEvent<{ tabId: string; workspaceId: string }>).detail);
    window.addEventListener('o8:request-select-tab', onSelect);
    try {
      await act(async () => root.render(createElement(WorkspaceHeaderStrip, stripProps({
        paneCount: 4,
        workspaceId: 'active-pane',
        tabWorkspaceId: 'primary-session-owner',
      }))));
      await act(async () => container.querySelector<HTMLElement>('[data-o8-workspace-tab="tab-2"]')?.click());
      expect(selections).toEqual([{ tabId: 'tab-2', workspaceId: 'primary-session-owner' }]);
      expect(container.querySelector('button[aria-label="Add pane (workspace)"]')).not.toBeNull();
    } finally {
      window.removeEventListener('o8:request-select-tab', onSelect);
    }
  });

  it('targets a new chat pane without opening the bottom panel', async () => {
    const toggleBottomPanel = vi.fn();
    const splits: Array<{ kind: string; direction: string; workspaceId: string }> = [];
    const onSplit = (event: Event) => {
      splits.push((event as CustomEvent<{ kind: string; direction: string; workspaceId: string }>).detail);
    };
    window.addEventListener('o8:request-split-workspace-tab', onSplit);
    try {
      await act(async () => root.render(createElement(WorkspaceHeaderStrip, stripProps({
        onToggleBottomPanel: toggleBottomPanel,
      }))));
      await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Add pane (workspace)"]')?.click());
      const items = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
      await act(async () => items.find((item) => item.textContent === 'Chat')?.click());
      expect(splits).toEqual([{ kind: 'chat', direction: 'right', workspaceId: 'ws-1' }]);
      expect(toggleBottomPanel).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('o8:request-split-workspace-tab', onSplit);
    }
  });

  it('keeps the header Chat and Terminal choices draggable for exact placement', async () => {
    await act(async () => root.render(createElement(WorkspaceHeaderStrip, stripProps())));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Add pane (workspace)"]')?.click());
    const items = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    expect(items.filter((item) => item.textContent === 'Chat' || item.textContent === 'Terminal').every((item) => item.draggable)).toBe(true);
  });

  it('identifies each tab by session id, not by its user-authored title', async () => {
    const props = stripProps();
    await act(async () => root.render(createElement(WorkspaceHeaderStrip, props)));

    const before = Array.from(container.querySelectorAll('[role="tab"]'))
      .map((tab) => (tab as HTMLElement).dataset.o8WorkspaceTab);
    expect(before).toEqual(['tab-0', 'tab-1', 'tab-2']);

    // Rename every tab. The stable handles must not move.
    await act(async () => root.render(createElement(WorkspaceHeaderStrip, {
      ...props,
      headerTabs: props.headerTabs!.map((tab) => ({ ...tab, label: `${tab.label} (renamed)` })),
    })));

    const after = Array.from(container.querySelectorAll('[role="tab"]'))
      .map((tab) => (tab as HTMLElement).dataset.o8WorkspaceTab);
    expect(after).toEqual(before);
    expect(container.querySelector('[data-o8-workspace-tab-close="tab-2"]')).not.toBeNull();
  });

  it('keeps the close control in the accessibility tree and reachable without a pointer', async () => {
    await act(async () => root.render(createElement(WorkspaceHeaderStrip, stripProps())));

    // Never hovered: the close control still exists, still carries a label.
    const close = container.querySelector<HTMLButtonElement>('[data-o8-workspace-tab-close="tab-1"]');
    expect(close).not.toBeNull();
    expect(close!.getAttribute('aria-label')).toBe('Close Rename me later');
    expect(close!.getAttribute('aria-hidden')).toBeNull();
    // The active tab owns the roving tab stop, so its close button is in the
    // tab sequence too.
    expect(close!.tabIndex).toBe(0);

    let closed: string | null = null;
    const onClose = (event: Event) => {
      closed = (event as CustomEvent<{ tabId: string }>).detail.tabId;
    };
    window.addEventListener('o8:request-close-tab', onClose);
    await act(async () => {
      close!.focus();
    });
    expect(document.activeElement).toBe(close);
    await act(async () => {
      close!.click();
    });
    window.removeEventListener('o8:request-close-tab', onClose);
    expect(closed).toBe('tab-1');
  });

  it('roves focus with the arrow keys and selects on Enter, not on arrow', async () => {
    await act(async () => root.render(createElement(WorkspaceHeaderStrip, stripProps())));

    const tabs = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));
    // Roving tabindex: only the active tab is in the Tab sequence.
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);

    const selections: string[] = [];
    const onSelect = (event: Event) => {
      selections.push((event as CustomEvent<{ tabId: string }>).detail.tabId);
    };
    window.addEventListener('o8:request-select-tab', onSelect);

    await act(async () => { tabs[1].focus(); });
    await act(async () => {
      tabs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(document.activeElement).toBe(tabs[2]);
    // Manual activation: moving focus must not switch the session.
    expect(selections).toEqual([]);

    await act(async () => {
      tabs[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    window.removeEventListener('o8:request-select-tab', onSelect);
    expect(selections).toEqual(['tab-2']);
  });

  it('wraps Home/End to the ends of the strip', async () => {
    await act(async () => root.render(createElement(WorkspaceHeaderStrip, stripProps())));
    const tabs = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));

    await act(async () => { tabs[1].focus(); });
    await act(async () => {
      tabs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    expect(document.activeElement).toBe(tabs[2]);

    await act(async () => {
      tabs[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    });
    expect(document.activeElement).toBe(tabs[0]);
  });

  it('keeps the narrow-window panel toggle visible but unavailable until widening', async () => {
    const onToggleRightPanel = vi.fn();
    const props = stripProps({ headerTabs: [], onToggleRightPanel, rightPanelDisabled: true });
    await act(async () => root.render(createElement(WorkspaceHeaderStrip, props)));

    const narrowToggle = container.querySelector<HTMLButtonElement>('[aria-label="Widen the window to open the side panel"]');
    expect(narrowToggle?.getAttribute('aria-disabled')).toBe('true');
    await act(async () => { narrowToggle?.click(); });
    expect(onToggleRightPanel).not.toHaveBeenCalled();

    await act(async () => root.render(createElement(WorkspaceHeaderStrip, { ...props, rightPanelDisabled: false })));
    const wideToggle = container.querySelector<HTMLButtonElement>('[aria-label="Open O8 panel"]');
    expect(wideToggle?.getAttribute('aria-disabled')).toBe('false');
    await act(async () => { wideToggle?.click(); });
    expect(onToggleRightPanel).toHaveBeenCalledOnce();
  });
});
