/** @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PromptLibraryEntry, PromptLibraryImportSource } from '@/lib/prompt-library/client';
import { PromptLibraryTab } from './PromptLibraryTab';

const prompt: PromptLibraryEntry = {
  id: 'prompt-1',
  title: 'Security review',
  body: 'Review authentication boundaries.',
  tags: ['security'],
  scope: 'repo',
  repoPath: '/repos/o8',
  sourceKind: 'manual',
  sourceId: null,
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  useCount: 0,
};

const importSource: PromptLibraryImportSource = {
  key: 'automation:auto-1',
  sourceKind: 'automation',
  sourceId: 'auto-1',
  title: 'Release checks',
  preview: 'Run the release checks.',
  repoPath: '/repos/o8',
};

let host: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.trim() === label);
}

async function settle(ms = 30) {
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, ms)); });
}

describe('PromptLibraryTab', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/prompt-library/import?')) {
        return { ok: true, json: async () => ({ ok: true, sources: [importSource] }) } as Response;
      }
      if (url === '/api/prompt-library/import' && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ ok: true, entries: [{ ...prompt, id: 'prompt-imported' }], created: 1, skipped: 0 }),
        } as Response;
      }
      if (url.startsWith('/api/prompt-library?')) {
        return { ok: true, json: async () => ({ ok: true, prompts: [prompt] }) } as Response;
      }
      if (url === '/api/prompt-library/prompt-1' && init?.method === 'PATCH') {
        return { ok: true, json: async () => ({ ok: true, prompt }) } as Response;
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('offers an intentional import and preserves source identity through the API seam', async () => {
    const onCountDelta = vi.fn();
    act(() => root.render(createElement(PromptLibraryTab, {
      query: '',
      repoPath: '/repos/o8',
      repoName: 'o8',
      onInsert: vi.fn(),
      onCountDelta,
    })));
    await settle();

    act(() => button('Import existing')?.click());
    expect(document.body.textContent).toContain('1 automation · original repo scope preserved');
    await act(async () => button('Import')?.click());
    await settle();

    const request = fetchMock.mock.calls.find(([url, init]) => (
      url === '/api/prompt-library/import' && (init as RequestInit | undefined)?.method === 'POST'
    ));
    expect(JSON.parse(String((request?.[1] as RequestInit).body))).toEqual({
      sources: [{ sourceKind: 'automation', sourceId: 'auto-1' }],
      repoPath: '/repos/o8',
    });
    expect(onCountDelta).toHaveBeenCalledWith(1);
  });

  it('renders editing controls inside the selected prompt row', async () => {
    act(() => root.render(createElement(PromptLibraryTab, {
      query: '',
      repoPath: '/repos/o8',
      repoName: 'o8',
      onInsert: vi.fn(),
      onCountDelta: vi.fn(),
    })));
    await settle();

    const rowButton = [...document.querySelectorAll<HTMLElement>('[role="button"]')]
      .find((candidate) => candidate.textContent?.includes(prompt.title));
    act(() => rowButton?.click());
    act(() => button('Edit')?.click());

    const textarea = document.querySelector('textarea');
    expect(textarea?.value).toBe(prompt.body);
    expect(rowButton?.parentElement?.contains(textarea ?? null)).toBe(true);
  });
});
