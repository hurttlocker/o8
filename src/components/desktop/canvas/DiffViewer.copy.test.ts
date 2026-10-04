// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiffViewer } from './CanvasDiffMermaidViewers';

vi.mock('../lucide-shims', () => ({
  Check: () => createElement('span', { 'data-icon': 'check' }),
  Clipboard: () => createElement('span', { 'data-icon': 'clipboard' }),
  RotateCcw: () => createElement('span', { 'data-icon': 'refresh' }),
  Trash2: () => createElement('span', { 'data-icon': 'discard' }),
}));

vi.mock('@/components/desktop/diff-utils', () => ({
  DiffStatusIcon: () => createElement('span', { 'data-icon': 'status' }),
  renderDiffLines: (preview: string) => preview,
}));

const FILE_PATH = 'src/example.ts';
const PREVIEW = '+example change';

function deferredWrite() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe('DiffViewer path-copy feedback', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalClipboard: PropertyDescriptor | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  function setClipboard(value: Pick<Clipboard, 'writeText'> | undefined) {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value });
  }

  function copyButton() {
    const button = container.querySelector<HTMLButtonElement>('button[title="Copy path"]');
    expect(button).not.toBeNull();
    return button!;
  }

  function expectCopyIcon(button = copyButton()) {
    expect(button.querySelector('[data-icon="clipboard"]')).not.toBeNull();
    expect(button.querySelector('[data-icon="check"]')).toBeNull();
  }

  function expectSuccessIcon(button = copyButton()) {
    expect(button.querySelector('[data-icon="check"]')).not.toBeNull();
    expect(button.querySelector('[data-icon="clipboard"]')).toBeNull();
  }

  function expectSelectionUnchanged() {
    expect(container.textContent).toContain('Select a file to see the diff');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/review/workspace');
  }

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    setClipboard({ writeText: vi.fn(async () => {}) });
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/review/workspace') {
        return { ok: true, json: async () => ({
          changedFiles: [{ path: FILE_PATH, status: 'modified', additions: 1, deletions: 0 }],
        }) };
      }
      if (url === `/api/review/file?path=${encodeURIComponent(FILE_PATH)}`) {
        return { ok: true, json: async () => ({
          file: { path: FILE_PATH, status: 'modified', additions: 1, deletions: 0, preview: PREVIEW },
        }) };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root.render(createElement(DiffViewer)); });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
    else Reflect.deleteProperty(navigator, 'clipboard');
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('waits for a pending write before showing success and starting the 1500 ms reset', async () => {
    const pending = deferredWrite();
    const writeText = vi.fn(() => pending.promise);
    setClipboard({ writeText });
    const button = copyButton();

    act(() => button.click());
    expect(writeText).toHaveBeenCalledExactlyOnceWith(FILE_PATH);
    expectCopyIcon(button);
    expectSelectionUnchanged();
    act(() => { vi.advanceTimersByTime(2_000); });
    expectCopyIcon(button);

    await act(async () => { pending.resolve(); });
    expectSuccessIcon(button);
    expectSelectionUnchanged();
    act(() => { vi.advanceTimersByTime(1_499); });
    expectSuccessIcon(button);
    act(() => { vi.advanceTimersByTime(1); });
    expectCopyIcon(button);
  });

  it('shows success after a resolved write without changing the selected file', async () => {
    const fileButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('example.ts'))!;
    await act(async () => { fileButton.click(); });
    expect(container.textContent).toContain(PREVIEW);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });

    await act(async () => { copyButton().click(); });
    expect(writeText).toHaveBeenCalledExactlyOnceWith(FILE_PATH);
    expectSuccessIcon();
    expect(container.textContent).toContain(PREVIEW);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('handles a rejected write without false success and allows a retry', async () => {
    const writeText = vi.fn()
      .mockRejectedValueOnce(new Error('Clipboard permission denied'))
      .mockResolvedValueOnce(undefined);
    setClipboard({ writeText });

    await act(async () => { copyButton().click(); });
    expectCopyIcon();
    expect(copyButton().disabled).toBe(false);
    expectSelectionUnchanged();

    await act(async () => { copyButton().click(); });
    expect(writeText).toHaveBeenNthCalledWith(1, FILE_PATH);
    expect(writeText).toHaveBeenNthCalledWith(2, FILE_PATH);
    expectSuccessIcon();
    expectSelectionUnchanged();
  });

  it('handles an unavailable clipboard and allows a later retry', async () => {
    setClipboard(undefined);
    await act(async () => { copyButton().click(); });
    expectCopyIcon();
    expect(copyButton().disabled).toBe(false);
    expectSelectionUnchanged();

    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    await act(async () => { copyButton().click(); });
    expect(writeText).toHaveBeenCalledExactlyOnceWith(FILE_PATH);
    expectSuccessIcon();
    expectSelectionUnchanged();
  });

  it('handles a synchronous clipboard failure without false success', async () => {
    setClipboard({ writeText: vi.fn(() => { throw new Error('Clipboard unavailable'); }) });
    await act(async () => { copyButton().click(); });
    expectCopyIcon();
    expect(copyButton().disabled).toBe(false);
    expectSelectionUnchanged();
  });
});
