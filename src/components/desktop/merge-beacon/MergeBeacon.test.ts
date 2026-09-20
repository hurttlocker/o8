// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MergeBeacon } from './MergeBeacon';
import type { ParkedLane } from './derive';

vi.mock('@/lib/presentation/quiet-mode-client', () => ({
  useQuietMode: () => false,
}));

vi.mock('@/lib/presentation/quiet-mode-policy', () => ({
  noticeIsVisible: () => true,
}));

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

function approvedLane(overrides: Partial<ParkedLane> = {}): ParkedLane {
  return {
    laneId: 'lane-safe',
    packetId: 'packet-safe',
    status: 'reviewing',
    reviewState: 'awaiting-merge',
    label: 'Keep merge selection honest',
    branch: 'fix/merge-selection',
    repoPath: '/repo',
    ...overrides,
  };
}

describe('MergeBeacon review entrypoint', () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.unstubAllGlobals();
  });

  it('opens the exact approved lane for review without posting a merge', async () => {
    const lane = approvedLane();
    const openReview = vi.fn();

    await act(async () => {
      root.render(createElement(MergeBeacon, { parked: [lane], onOpenNeedsReviewLane: openReview }));
    });

    const reviewButton = container.querySelector<HTMLButtonElement>('button[aria-label^="Review merge"]');
    expect(reviewButton).not.toBeNull();
    expect(reviewButton?.title).toContain('Keep merge selection honest');
    expect(reviewButton?.title).toContain('fix/merge-selection');

    await act(async () => { reviewButton?.click(); });

    expect(openReview).toHaveBeenCalledWith(lane);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses Review merge to choose among multiple approved lanes without implying a bulk merge', async () => {
    const first = approvedLane();
    const second = approvedLane({
      laneId: 'lane-second',
      packetId: 'packet-second',
      label: 'Review the second packet',
      branch: 'fix/second-packet',
    });
    const openReview = vi.fn();

    await act(async () => {
      root.render(createElement(MergeBeacon, { parked: [first, second], onOpenNeedsReviewLane: openReview }));
    });

    const reviewButton = container.querySelector<HTMLButtonElement>('button[aria-label^="Review merge"]');
    expect(reviewButton).not.toBeNull();
    expect(container.querySelector('button[aria-label="Choose approved lane"]')).toBeNull();
    await act(async () => { reviewButton?.click(); });

    expect(document.body.textContent).toContain('2 approved lanes');
    const secondChoice = document.querySelector<HTMLButtonElement>('button[aria-label="Review Review the second packet"]');
    expect(secondChoice).not.toBeNull();
    await act(async () => { secondChoice?.click(); });

    expect(openReview).toHaveBeenCalledWith(second);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps chooser navigation, Escape, Tab, and focus behavior through the portal', async () => {
    const first = approvedLane();
    const second = approvedLane({ laneId: 'lane-second', packetId: 'packet-second', label: 'Second lane' });

    await act(async () => {
      root.render(createElement(MergeBeacon, { parked: [first, second] }));
    });

    const reviewButton = container.querySelector<HTMLButtonElement>('button[aria-label^="Review merge"]')!;
    await act(async () => { reviewButton.click(); });
    await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
    const firstChoice = document.querySelector<HTMLButtonElement>('button[aria-label="Review Keep merge selection honest"]');
    const secondChoice = document.querySelector<HTMLButtonElement>('button[aria-label="Review Second lane"]');
    expect(document.activeElement).toBe(firstChoice);

    await act(async () => { firstChoice?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    expect(document.activeElement).toBe(secondChoice);
    await act(async () => { secondChoice?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); });
    expect(document.activeElement).toBe(firstChoice);
    await act(async () => { firstChoice?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); });
    expect(document.activeElement).toBe(secondChoice);
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    await act(async () => { secondChoice?.dispatchEvent(tab); });
    expect(tab.defaultPrevented).toBe(false);
    await act(async () => { secondChoice?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(reviewButton);

    await act(async () => { reviewButton.click(); });
    await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(reviewButton);
  });

  it('keeps a large approved-lane queue scrollable without scrollbar chrome', async () => {
    const lanes = Array.from({ length: 30 }, (_, index) => approvedLane({
      laneId: `lane-${index}`,
      packetId: `packet-${index}`,
      label: `Approved lane ${index + 1}`,
      branch: `fix/lane-${index + 1}`,
    }));

    await act(async () => {
      root.render(createElement(MergeBeacon, { parked: lanes }));
    });

    const reviewButton = container.querySelector<HTMLButtonElement>('button[aria-label^="Review merge"]');
    await act(async () => { reviewButton?.click(); });

    const menu = document.querySelector<HTMLDivElement>('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(menu?.querySelectorAll('[role="menuitem"]')).toHaveLength(30);
    expect(menu?.style.width).toBe('min(300px, calc(100vw * var(--zoom-inverse, 1) - 24px))');
    expect(menu?.style.maxHeight).toBe('min(320px, calc(100vh * var(--zoom-inverse, 1) - 72px))');
    expect(menu?.style.overflowY).toBe('auto');
    expect(menu?.style.scrollbarWidth).toBe('none');
    expect(menu?.className).toBe('');
  });

  it('removes the review action when the selected approval is no longer valid', async () => {
    const lane = approvedLane();

    await act(async () => {
      root.render(createElement(MergeBeacon, { parked: [lane] }));
    });
    expect(container.querySelector('button[aria-label^="Review merge"]')).not.toBeNull();

    await act(async () => {
      root.render(createElement(MergeBeacon, {
        parked: [{ ...lane, reviewState: 'needs-review' }],
      }));
    });

    expect(container.querySelector('button[aria-label^="Review merge"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="No approved work to review"]')?.disabled).toBe(true);
  });
});
