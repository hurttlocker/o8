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
});
