// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dictationHistoryGet, dictationHistoryDelete, dictationHistoryClear,
  type DictationHistoryEntry,
} from '@/lib/tauri/bridge';
import HistoryTab from './HistoryTab';

vi.mock('@/lib/tauri/bridge', () => ({
  dictationHistoryGet: vi.fn(),
  dictationHistoryDelete: vi.fn(),
  dictationHistoryClear: vi.fn(),
}));

const ENTRIES: DictationHistoryEntry[] = [
  { id: 'first', ts: 1_800_000_000, mode: 'dictation', text: 'First synthetic entry.', app: '' },
  { id: 'second', ts: 1_799_999_900, mode: 'ask', text: '  Second synthetic entry.\n', app: '' },
];

describe('HistoryTab clipboard feedback', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalClipboard: PropertyDescriptor | undefined;

  function setClipboard(value: Pick<Clipboard, 'writeText'> | undefined) {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value });
  }

  function copyButtons() {
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Copy text"], button[aria-label="Copied"]',
    ));
    expect(buttons).toHaveLength(2);
    return buttons;
  }

  function expectCopiedOnly(index: number | null) {
    copyButtons().forEach((button, i) => {
      expect(button.getAttribute('aria-label')).toBe(i === index ? 'Copied' : 'Copy text');
    });
  }

  async function renderHistory(entries = ENTRIES) {
    vi.mocked(dictationHistoryGet).mockResolvedValue(entries);
    await act(async () => { root.render(createElement(HistoryTab)); });
    expect(dictationHistoryGet).toHaveBeenCalledOnce();
    expectCopiedOnly(null);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_800_000_010_000));
    originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    setClipboard({ writeText: vi.fn(async () => {}) });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
    else Reflect.deleteProperty(navigator, 'clipboard');
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    expect(dictationHistoryDelete).not.toHaveBeenCalled();
    expect(dictationHistoryClear).not.toHaveBeenCalled();
  });

  it('waits for completion before showing Copied and starting its 1400 ms reset', async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((complete) => { resolve = complete; });
    const writeText = vi.fn(() => pending);
    setClipboard({ writeText });
    await renderHistory();

    act(() => copyButtons()[0].click());
    expect(writeText).toHaveBeenCalledExactlyOnceWith(ENTRIES[0].text);
    expectCopiedOnly(null);
    act(() => { vi.advanceTimersByTime(2_000); });
    expectCopiedOnly(null);

    await act(async () => { resolve(); });
    expectCopiedOnly(0);
    act(() => { vi.advanceTimersByTime(1_399); });
    expectCopiedOnly(0);
    act(() => { vi.advanceTimersByTime(1); });
    expectCopiedOnly(null);
  });

  it('copies the exact second entry text and changes only that entry feedback', async () => {
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    await renderHistory();

    await act(async () => { copyButtons()[1].click(); });
    expect(writeText).toHaveBeenCalledExactlyOnceWith(ENTRIES[1].text);
    expectCopiedOnly(1);
  });

  it('keeps Copy text after rejection and allows a successful retry', async () => {
    const writeText = vi.fn()
      .mockRejectedValueOnce(new Error('Clipboard write denied'))
      .mockResolvedValueOnce(undefined);
    setClipboard({ writeText });
    await renderHistory();

    await act(async () => { copyButtons()[0].click(); });
    expectCopiedOnly(null);
    expect(copyButtons()[0].disabled).toBe(false);
    await act(async () => { copyButtons()[0].click(); });
    expect(writeText).toHaveBeenNthCalledWith(1, ENTRIES[0].text);
    expect(writeText).toHaveBeenNthCalledWith(2, ENTRIES[0].text);
    expectCopiedOnly(0);
  });

  it('keeps Copy text when the clipboard is missing and allows a later retry', async () => {
    setClipboard(undefined);
    await renderHistory();
    await act(async () => { copyButtons()[1].click(); });
    expectCopiedOnly(null);

    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    await act(async () => { copyButtons()[1].click(); });
    expect(writeText).toHaveBeenCalledExactlyOnceWith(ENTRIES[1].text);
    expectCopiedOnly(1);
  });

  it('handles a synchronous clipboard failure without reporting success', async () => {
    setClipboard({ writeText: vi.fn(() => { throw new Error('Clipboard unavailable'); }) });
    await renderHistory();
    await act(async () => { copyButtons()[0].click(); });
    expectCopiedOnly(null);
  });

  it('does not write or show Copied for whitespace-only text', async () => {
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    await renderHistory([{ ...ENTRIES[0], text: ' \n\t ' }, ENTRIES[1]]);

    await act(async () => { copyButtons()[0].click(); });
    expect(writeText).not.toHaveBeenCalled();
    expectCopiedOnly(null);
  });

  it('does not let a previous entry reset clear a newer entry confirmation', async () => {
    await renderHistory();
    await act(async () => { copyButtons()[0].click(); });
    expectCopiedOnly(0);
    act(() => { vi.advanceTimersByTime(700); });
    await act(async () => { copyButtons()[1].click(); });
    expectCopiedOnly(1);
    act(() => { vi.advanceTimersByTime(700); });
    expectCopiedOnly(1);
    act(() => { vi.advanceTimersByTime(700); });
    expectCopiedOnly(null);
  });
});
