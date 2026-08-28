// @vitest-environment jsdom

import { act, createElement, type ReactNode, useCallback, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiffGlassCard, type DiffCard } from './diff-card';
import { dispatchWorktreeChanged, fetchWorktreeDiff, worktreeRepoPath } from './worktree-diff';

vi.mock('./card-shell', () => ({
  GlassCardShell: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));
vi.mock('./perf/render-probe', () => ({ useCanvasRenderProbe: vi.fn() }));
vi.mock('./use-scroll-blur-fade', () => ({ useScrollBlurFade: vi.fn() }));

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;
const REPO_PATH = '/tmp/o8-canvas-repo';

const callbacks = {
  onMove: vi.fn(),
  onResize: vi.fn(),
  onFocus: vi.fn(),
  onClose: vi.fn(),
  onRequestChanges: vi.fn(),
};

function worktreeCard(overrides: Partial<DiffCard> = {}): DiffCard {
  return {
    id: 1,
    x: 10,
    y: 20,
    z: 3,
    w: 560,
    h: 320,
    laneId: `worktree:${REPO_PATH}`,
    packetId: null,
    title: 'Your changes',
    branch: 'feat/test',
    stat: '1 file changed',
    diff: 'diff --git a/file.ts b/file.ts\n+initial content',
    truncated: false,
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response;
}

function CardHarness({ initialCard, onChanged }: { initialCard: DiffCard; onChanged: (cardId: number) => void }) {
  const [card, setCard] = useState(initialCard);
  const refresh = useCallback(async (cardId: number) => {
    const repoPath = worktreeRepoPath(initialCard.laneId);
    if (!repoPath) return;
    const data = await fetchWorktreeDiff(repoPath);
    if (!data) return;
    setCard((current) => current.id === cardId
      ? { ...current, stat: data.stat, diff: data.diff, truncated: data.truncated }
      : current);
  }, [initialCard.laneId]);
  return createElement(DiffGlassCard, { card, ...callbacks, onRefresh: refresh, onChanged });
}

function buttonWithText(container: HTMLElement, label: string): HTMLButtonElement | null {
  return [...container.querySelectorAll('button')].find((button) => button.textContent === label) ?? null;
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('DiffGlassCard worktree actions', () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('refreshes the existing worktree card for matching change events only', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ok: true,
      branch: 'feat/test',
      stat: '2 files changed',
      diff: 'diff --git a/file.ts b/file.ts\n+refreshed content',
      truncated: false,
    }));
    act(() => root.render(createElement(CardHarness, { initialCard: worktreeCard(), onChanged: vi.fn() })));
    expect(container.textContent).toContain('initial content');

    await act(async () => {
      dispatchWorktreeChanged(REPO_PATH);
      await flushAsyncWork();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/panel/worktree-diff?workspace=${encodeURIComponent(REPO_PATH)}&maxBytes=131072`);
    expect(container.textContent).toContain('refreshed content');
    act(() => dispatchWorktreeChanged('/tmp/different-repo'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes on the interval only while the document is visible', async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, branch: 'feat/test', stat: '', diff: '+interval refresh', truncated: false }));
    act(() => root.render(createElement(CardHarness, { initialCard: worktreeCard(), onChanged: vi.fn() })));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
      await flushAsyncWork();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    visibility = 'hidden';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
      await flushAsyncWork();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not request a commit for an empty or whitespace-only message', () => {
    act(() => root.render(createElement(CardHarness, { initialCard: worktreeCard(), onChanged: vi.fn() })));
    act(() => buttonWithText(container, 'Commit')?.click());
    const form = container.querySelector('form');
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Commit message"]');
    expect(form).not.toBeNull();
    expect(input).not.toBeNull();

    act(() => { form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(fetchMock).not.toHaveBeenCalled();
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '   ');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(buttonWithText(container, 'Commit')?.disabled).toBe(true);
    act(() => { form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('commits a non-empty message, reports the hash, and refreshes the card', async () => {
    const onChanged = vi.fn();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ ok: true, hash: 'abc123456789', message: 'Commit canvas change' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, branch: 'feat/test', stat: '', diff: '', truncated: false }));
    act(() => root.render(createElement(CardHarness, { initialCard: worktreeCard(), onChanged })));

    act(() => buttonWithText(container, 'Commit')?.click());
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Commit message"]');
    const submit = buttonWithText(container, 'Commit');
    expect(input).not.toBeNull();
    expect(submit?.disabled).toBe(true);
    act(() => submit?.click());
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(input, 'Commit canvas change');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(buttonWithText(container, 'Commit')?.disabled).toBe(false);

    await act(async () => {
      buttonWithText(container, 'Commit')?.click();
      await flushAsyncWork();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/review/commit');
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body))).toEqual({
      message: 'Commit canvas change',
      workspace: REPO_PATH,
    });
    expect(onChanged).toHaveBeenCalledOnce();
    expect(onChanged).toHaveBeenCalledWith(1);
    expect(container.textContent).toContain('Committed abc12345');
    expect(container.textContent).toContain('No uncommitted changes');
  });

  it('keeps lane cards free of worktree controls and refresh listeners', async () => {
    vi.useFakeTimers();
    const addEventListener = vi.spyOn(window, 'addEventListener');
    const onRefresh = vi.fn();
    const laneCard = worktreeCard({ laneId: 'lane-123', packetId: 'packet-123' });
    act(() => root.render(createElement(DiffGlassCard, {
      card: laneCard,
      ...callbacks,
      onRefresh,
      onChanged: vi.fn(),
    })));

    expect(buttonWithText(container, 'Commit')).toBeNull();
    expect(addEventListener.mock.calls.map(([eventName]) => eventName)).not.toContain('o8:worktree-changed');
    expect(addEventListener.mock.calls.map(([eventName]) => eventName)).not.toContain('o8:lifecycle-reconcile');
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(onRefresh).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
