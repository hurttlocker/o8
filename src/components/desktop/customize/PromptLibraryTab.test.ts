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

const personalPrompt: PromptLibraryEntry = {
  ...prompt,
  id: 'prompt-personal',
  title: 'Personal briefing',
  body: 'Use my standard briefing format.',
  scope: 'global',
  repoPath: null,
};

const webPrompt: PromptLibraryEntry = {
  ...prompt,
  id: 'prompt-web',
  title: 'Web release review',
  body: 'Review the web release.',
  repoPath: '/repos/web',
};

const apiPrompt: PromptLibraryEntry = {
  ...prompt,
  id: 'prompt-api',
  title: 'API release review',
  body: 'Review the API release.',
  repoPath: '/repos/api',
};

const outsidePrompt: PromptLibraryEntry = {
  ...prompt,
  id: 'prompt-outside',
  title: 'Outside repository prompt',
  body: 'This prompt belongs to another repository.',
  repoPath: '/repos/outside',
};

const importSource: PromptLibraryImportSource = {
  key: 'automation:auto-1',
  sourceKind: 'automation',
  sourceId: 'auto-1',
  title: 'Release checks',
  preview: 'Run the release checks.',
  repoPath: '/repos/o8',
};

const webImportSource: PromptLibraryImportSource = {
  ...importSource,
  key: 'automation:web-auto',
  sourceId: 'web-auto',
  title: 'Web release checks',
  repoPath: '/repos/web',
};

const apiImportSource: PromptLibraryImportSource = {
  ...importSource,
  key: 'automation:api-auto',
  sourceId: 'api-auto',
  title: 'API release checks',
  repoPath: '/repos/api',
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
      const parsed = new URL(url, 'http://localhost');
      if (url.startsWith('/api/prompt-library/import?')) {
        const repo = parsed.searchParams.get('repoPath');
        const sources = repo === '/repos/o8'
          ? [importSource]
          : repo === '/repos/web'
            ? [webImportSource]
            : repo === '/repos/api' ? [apiImportSource] : [];
        return { ok: true, json: async () => ({ ok: true, sources }) } as Response;
      }
      if (url === '/api/prompt-library/import' && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ ok: true, entries: [{ ...prompt, id: 'prompt-imported' }], created: 1, skipped: 0 }),
        } as Response;
      }
      if (url === '/api/prompt-library' && init?.method === 'POST') {
        const input = JSON.parse(String(init.body)) as Pick<PromptLibraryEntry, 'title' | 'body' | 'tags' | 'scope' | 'repoPath'>;
        return {
          ok: true,
          json: async () => ({ ok: true, prompt: { ...prompt, ...input, id: 'prompt-created' }, created: true }),
        } as Response;
      }
      if (url.startsWith('/api/prompt-library?')) {
        const repo = parsed.searchParams.get('repoPath');
        const prompts = repo === '/repos/o8'
          ? [prompt]
          : repo === '/repos/web'
            ? [personalPrompt, webPrompt, outsidePrompt]
            : repo === '/repos/api'
              ? [personalPrompt, apiPrompt, outsidePrompt]
              : [personalPrompt, outsidePrompt];
        return { ok: true, json: async () => ({ ok: true, prompts }) } as Response;
      }
      if (url.startsWith('/api/prompt-library/') && init?.method === 'PATCH') {
        const id = decodeURIComponent(url.split('/').pop() ?? '');
        const existing = [prompt, personalPrompt, webPrompt, apiPrompt, outsidePrompt]
          .find((entry) => entry.id === id) ?? prompt;
        const update = JSON.parse(String(init.body)) as Partial<PromptLibraryEntry>;
        return { ok: true, json: async () => ({ ok: true, prompt: { ...existing, ...update } }) } as Response;
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

    act(() => button('New prompt')?.click());
    expect(document.querySelector<HTMLSelectElement>('select[aria-label="Prompt destination"]')?.value)
      .toBe('/repos/o8');
  });

  it('creates an all-project prompt in the explicitly selected member repository', async () => {
    act(() => root.render(createElement(PromptLibraryTab, {
      query: '',
      repoPath: null,
      repoName: 'Personal',
      repoPaths: ['/repos/web', '/repos/api'],
      onInsert: vi.fn(),
      onCountDelta: vi.fn(),
    })));
    await settle();

    act(() => button('New prompt')?.click());
    const destination = document.querySelector<HTMLSelectElement>('select[aria-label="Prompt destination"]');
    expect(destination?.value).toBe('personal');
    expect([...destination?.options ?? []].map((option) => [option.text, option.value])).toEqual([
      ['Personal', 'personal'],
      ['web', '/repos/web'],
      ['api', '/repos/api'],
    ]);

    const title = document.querySelector<HTMLInputElement>('input');
    const body = document.querySelector<HTMLTextAreaElement>('textarea');
    act(() => {
      const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      inputSetter?.call(title, 'API deployment review');
      title?.dispatchEvent(new Event('input', { bubbles: true }));
      const textareaSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      textareaSetter?.call(body, 'Review the API deployment contract.');
      body?.dispatchEvent(new Event('input', { bubbles: true }));
      if (destination) {
        destination.value = '/repos/api';
        destination.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await act(async () => button('Save prompt')?.click());
    await settle();

    const request = fetchMock.mock.calls.find(([url, init]) => (
      url === '/api/prompt-library' && (init as RequestInit | undefined)?.method === 'POST'
    ));
    expect(JSON.parse(String((request?.[1] as RequestInit).body))).toEqual({
      title: 'API deployment review',
      body: 'Review the API deployment contract.',
      tags: [],
      scope: 'repo',
      repoPath: '/repos/api',
    });
  });

  it('imports each aggregate source back into its original member repository', async () => {
    const onCountDelta = vi.fn();
    act(() => root.render(createElement(PromptLibraryTab, {
      query: '',
      repoPath: null,
      repoName: 'Personal',
      repoPaths: ['/repos/web', '/repos/api'],
      onInsert: vi.fn(),
      onCountDelta,
    })));
    await settle();

    act(() => button('Import existing')?.click());
    expect(document.body.textContent).toContain('2 automations · original repo scope preserved');
    await act(async () => button('Import')?.click());
    await settle();

    const requests = fetchMock.mock.calls
      .filter(([url, init]) => url === '/api/prompt-library/import' && (init as RequestInit | undefined)?.method === 'POST')
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { repoPath: string; sources: unknown[] })
      .sort((left, right) => left.repoPath.localeCompare(right.repoPath));
    expect(requests).toEqual([
      {
        sources: [{ sourceKind: 'automation', sourceId: 'api-auto' }],
        repoPath: '/repos/api',
      },
      {
        sources: [{ sourceKind: 'automation', sourceId: 'web-auto' }],
        repoPath: '/repos/web',
      },
    ]);
    expect(onCountDelta).toHaveBeenCalledWith(2);
  });

  it('shows only member repository prompts plus one personal copy and preserves repo origin on edit', async () => {
    act(() => root.render(createElement(PromptLibraryTab, {
      query: '',
      repoPath: null,
      repoName: 'Personal',
      repoPaths: ['/repos/web', '/repos/api'],
      onInsert: vi.fn(),
      onCountDelta: vi.fn(),
    })));
    await settle();

    const rows = [...document.querySelectorAll<HTMLElement>('[role="button"]')];
    expect(rows.filter((candidate) => candidate.textContent?.includes(personalPrompt.title))).toHaveLength(1);
    expect(rows.filter((candidate) => candidate.textContent?.includes(webPrompt.title))).toHaveLength(1);
    expect(rows.filter((candidate) => candidate.textContent?.includes(apiPrompt.title))).toHaveLength(1);
    expect(document.body.textContent).not.toContain(outsidePrompt.title);

    const listRepoPaths = fetchMock.mock.calls
      .filter(([url]) => String(url).startsWith('/api/prompt-library?'))
      .map(([url]) => new URL(String(url), 'http://localhost').searchParams.get('repoPath'))
      .sort();
    expect(listRepoPaths).toEqual(['/repos/api', '/repos/web']);
    const importRepoPaths = fetchMock.mock.calls
      .filter(([url, init]) => String(url).startsWith('/api/prompt-library/import?') && !init?.method)
      .map(([url]) => new URL(String(url), 'http://localhost').searchParams.get('repoPath'))
      .sort();
    expect(importRepoPaths).toEqual(['/repos/api', '/repos/web']);

    const rowButton = [...document.querySelectorAll<HTMLElement>('[role="button"]')]
      .find((candidate) => candidate.textContent?.includes(webPrompt.title));
    act(() => rowButton?.click());
    act(() => button('Edit')?.click());

    const textarea = document.querySelector('textarea');
    expect(textarea?.value).toBe(webPrompt.body);
    expect(rowButton?.parentElement?.contains(textarea ?? null)).toBe(true);
    const destination = document.querySelector<HTMLSelectElement>('select[aria-label="Prompt destination"]');
    expect(destination?.value).toBe('/repos/web');
    expect([...destination?.options ?? []].map((option) => option.value)).toContain('/repos/api');
    await act(async () => button('Save changes')?.click());
    await settle();

    const request = fetchMock.mock.calls.find(([url, init]) => (
      url === '/api/prompt-library/prompt-web' && (init as RequestInit | undefined)?.method === 'PATCH'
    ));
    expect(JSON.parse(String((request?.[1] as RequestInit).body))).toEqual(expect.objectContaining({
      scope: 'repo',
      repoPath: '/repos/web',
    }));
  });

  it('keeps personal-only scope free of repository prompts and import discovery', async () => {
    act(() => root.render(createElement(PromptLibraryTab, {
      query: '',
      repoPath: null,
      repoName: 'Personal',
      repoPaths: [],
      onInsert: vi.fn(),
      onCountDelta: vi.fn(),
    })));
    await settle();

    expect(document.body.textContent).toContain(personalPrompt.title);
    expect(document.body.textContent).not.toContain(outsidePrompt.title);
    expect(button('Import existing')).toBeUndefined();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/prompt-library/import?'))).toBe(false);
    const listRequest = fetchMock.mock.calls.find(([url]) => String(url).startsWith('/api/prompt-library?'));
    expect(new URL(String(listRequest?.[0]), 'http://localhost').searchParams.has('repoPath')).toBe(false);

    act(() => button('New prompt')?.click());
    expect(document.querySelector('select[aria-label="Prompt destination"]')).toBeNull();
    expect(document.body.textContent).toContain('Destination');
    expect(document.body.textContent).toContain('Personal');
  });
});
