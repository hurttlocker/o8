// @vitest-environment jsdom

import { act, createElement, type HTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/panel/search/route';
import { emptySearchGroups, type SearchResponse } from '@/lib/search/types';
import { CommandPalette, type CommandPaletteProps } from './CommandPalette';

const { searchFiles } = vi.hoisted(() => ({ searchFiles: vi.fn() }));
vi.mock('@/lib/search/files', () => ({ searchFiles }));
vi.mock('@/lib/search/agents', () => ({ searchAgents: async () => [] }));
vi.mock('@/lib/search/approvals', () => ({ searchApprovals: async () => [] }));
vi.mock('@/lib/search/conversations', () => ({ searchConversations: async () => [] }));
vi.mock('@/lib/search/directives', () => ({ searchDirectives: () => [] }));
vi.mock('@/lib/search/inbox', () => ({ searchInbox: async () => [] }));
vi.mock('@/lib/search/issues', () => ({ searchIssues: async () => [], browseIssues: async () => [] }));
vi.mock('@/lib/search/transcripts', () => ({ searchTranscripts: async () => [] }));

const fileResult = {
  kind: 'file' as const,
  id: 'file:README.md',
  title: 'README.md',
  detail: 'README.md',
  target: { filePath: 'README.md', workspace: '/repo' },
  score: 100,
};

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: {
    div: ({ children, ...props }: HTMLAttributes<HTMLDivElement> & {
      initial?: unknown;
      animate?: unknown;
      exit?: unknown;
      transition?: unknown;
    }) => {
      const domProps = { ...props };
      delete domProps.initial;
      delete domProps.animate;
      delete domProps.exit;
      delete domProps.transition;
      return createElement('div', domProps, children);
    },
  },
}));

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

const callbacks = {
  onClose: vi.fn(),
  onSelectIssue: vi.fn(),
  onSelectFile: vi.fn(),
  onSelectAgent: vi.fn(),
  onSelectChat: vi.fn(),
  onSelectPacket: vi.fn(),
  onSelectInbox: vi.fn(),
  onSelectDirective: vi.fn(),
};

describe('CommandPalette file mode', () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;

  async function mount(props: Partial<CommandPaletteProps> = {}) {
    await act(async () => {
      root.render(createElement(CommandPalette, {
        open: true,
        initialScope: 'file',
        workspace: '/repo',
        ...callbacks,
        ...props,
      }));
    });
    await settleSearch(0);
  }

  async function settleSearch(ms = 200) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }

  function input() {
    const element = container.querySelector<HTMLInputElement>('input');
    expect(element).not.toBeNull();
    return element!;
  }

  async function typeQuery(value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value);
      input().dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function clickClear() {
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]');
    expect(button).not.toBeNull();
    act(() => button!.click());
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    window.localStorage.clear();
    searchFiles.mockResolvedValue([fileResult]);
    fetcher = vi.fn<typeof fetch>(async (url, init) => GET(new Request(
      new URL(String(url), 'http://localhost'),
      { signal: init?.signal ?? undefined },
    )));
    vi.stubGlobal('fetch', fetcher);
    HTMLElement.prototype.scrollIntoView = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('selects a supplied repository path once', async () => {
    await act(async () => {
      root.render(createElement(CommandPalette, {
        open: true,
        initialScope: 'file',
        fileItems: [{ path: '/repo/src/page.tsx', title: 'page.tsx', detail: 'src/page.tsx' }],
        ...callbacks,
      }));
      await Promise.resolve();
    });

    const input = container.querySelector<HTMLInputElement>('input');
    expect(input?.placeholder).toBe('Search files by name...');
    const fileButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('page.tsx'));
    expect(fileButton).toBeDefined();
    act(() => fileButton?.click());

    expect(callbacks.onSelectFile).toHaveBeenCalledOnce();
    expect(callbacks.onSelectFile).toHaveBeenCalledWith('/repo/src/page.tsx', undefined);
    expect(callbacks.onClose).toHaveBeenCalledOnce();
  });

  it('explains one-character backend queries after keyboard navigation to Files', async () => {
    await mount({ initialScope: 'all' });
    for (let index = 0; index < 2; index += 1) {
      act(() => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
    }
    await settleSearch(0);
    expect(container.textContent).toContain('Type to search files.');

    await typeQuery('r');
    await settleSearch(0);
    expect(input().value).toBe('r');
    expect(container.textContent).toContain('Enter at least 2 characters to search files.');
    expect(searchFiles).not.toHaveBeenCalled();

    await typeQuery('re');
    expect(container.textContent).toContain('Searching');
    await settleSearch();
    expect(searchFiles).toHaveBeenCalledWith('re', '/repo');
    expect(container.textContent).toContain('README.md');
    expect(container.textContent).not.toContain('Enter at least 2 characters');
    const fileButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('README.md'));
    act(() => fileButton!.click());
    expect(callbacks.onSelectFile).toHaveBeenCalledWith('README.md', undefined, '/repo');
  });

  it.each([
    ['r', 'Enter at least 2 characters to search files.'],
    [' \t ', 'Type to search files.'],
  ])('clears backend results immediately when the query becomes %j', async (query, message) => {
    await mount();
    await typeQuery('re');
    await settleSearch();
    expect(container.textContent).toContain('README.md');
    const requestCount = fetcher.mock.calls.length;

    await typeQuery(query);
    expect(container.textContent).not.toContain('README.md');
    expect(container.textContent).toContain(message);
    await settleSearch();
    expect(fetcher).toHaveBeenCalledTimes(requestCount);
    expect(searchFiles).toHaveBeenCalledOnce();
  });

  it.each([
    ['r', 'Enter at least 2 characters to search files.'],
    [' \t ', 'Type to search files.'],
  ])('ignores an in-flight backend response after shortening to %j', async (query, message) => {
    await mount();
    let resolveBody!: (value: SearchResponse) => void;
    const body = new Promise<SearchResponse>((resolve) => { resolveBody = resolve; });
    fetcher.mockResolvedValueOnce({ ok: true, json: () => body } as Response);
    await typeQuery('re');
    await settleSearch();
    const signal = fetcher.mock.calls.at(-1)?.[1]?.signal;

    await typeQuery(query);
    expect(signal?.aborted).toBe(true);
    await act(async () => resolveBody({
      query: 're', results: [fileResult], groups: { ...emptySearchGroups(), file: [fileResult] },
    }));
    expect(container.textContent).not.toContain('README.md');
    expect(container.textContent).toContain(message);
  });

  it('identifies a valid no-match query and recovers after clear and retry', async () => {
    searchFiles.mockResolvedValue([]);
    await mount();
    await typeQuery(' zz ');
    expect(container.textContent).toContain('Searching');
    await settleSearch();
    expect(container.textContent).toContain('No files for “zz”.');

    clickClear();
    await settleSearch(0);
    expect(input().value).toBe('');
    expect(container.textContent).toContain('Type to search files.');
    searchFiles.mockResolvedValue([fileResult]);
    await typeQuery('re');
    await settleSearch();
    expect(container.textContent).toContain('README.md');
  });

  it('keeps supplied-file browsing, one-character matches, and no-match feedback local', async () => {
    await mount({ fileItems: [
      { path: '/repo/README.md', title: 'README.md', detail: 'README.md' },
      { path: '/repo/LICENSE', title: 'LICENSE', detail: 'LICENSE' },
    ] });
    expect(container.textContent).toContain('README.md');
    expect(container.textContent).toContain('LICENSE');

    await typeQuery(' r ');
    expect(container.textContent).toContain('README.md');
    expect(container.textContent).not.toContain('LICENSE');
    expect(container.textContent).not.toContain('Enter at least 2 characters');
    await typeQuery('z');
    expect(container.textContent).toContain('No files for “z”.');
    await typeQuery(' \t ');
    expect(container.textContent).toContain('README.md');
    expect(container.textContent).toContain('LICENSE');
    await typeQuery('re');
    expect(container.textContent).toContain('README.md');
    clickClear();
    expect(container.textContent).toContain('LICENSE');
    expect(fetcher).not.toHaveBeenCalled();
    expect(searchFiles).not.toHaveBeenCalled();
  });
});
