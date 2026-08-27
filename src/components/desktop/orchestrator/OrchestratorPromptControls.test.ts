/** @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OPEN_PROMPT_LIBRARY_EVENT,
  SAVE_PROMPT_LIBRARY_EVENT,
  type PromptLibraryEntry,
} from '@/lib/prompt-library/client';
import { OrchestratorPromptControls } from './OrchestratorPromptControls';

const savedPrompt: PromptLibraryEntry = {
  id: 'prompt-1',
  title: 'Security boundary review',
  body: 'Inspect authentication and authorization boundaries.',
  tags: ['security'],
  scope: 'global',
  repoPath: null,
  sourceKind: 'manual',
  sourceId: null,
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  useCount: 0,
};

let host: HTMLDivElement;
let root: Root;

describe('OrchestratorPromptControls', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const payload = url === '/api/prompt-library' && init?.method === 'POST'
        ? { ok: true, prompt: savedPrompt, created: true }
        : url.endsWith('/use')
        ? { ok: true, prompt: { ...savedPrompt, useCount: 1 } }
        : { ok: true, prompts: [savedPrompt] };
      return { ok: true, json: async () => payload } as Response;
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('opens from the real event seam and inserts the selected prompt with Enter', async () => {
    const composer = document.createElement('textarea');
    composer.dataset.o8ActiveComposer = 'true';
    composer.value = 'Review: ';
    document.body.appendChild(composer);
    composer.setSelectionRange(composer.value.length, composer.value.length);

    act(() => root.render(createElement(OrchestratorPromptControls, {
      active: true,
      repoPath: '/repos/o8',
      repoName: 'o8',
      onDraft: vi.fn(),
    })));
    act(() => window.dispatchEvent(new CustomEvent(OPEN_PROMPT_LIBRARY_EVENT)));
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 30)); });

    const search = document.querySelector<HTMLInputElement>('[aria-label="Search saved prompts"]');
    expect(search).not.toBeNull();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(search, 'security');
      search?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 120)); });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('query=security'),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    act(() => search?.dispatchEvent(enter));

    expect(enter.defaultPrevented).toBe(true);
    expect(composer.value).toBe(`Review: ${savedPrompt.body}`);
    expect(fetch).toHaveBeenCalledWith('/api/prompt-library/prompt-1/use', { method: 'POST' });
    composer.remove();
  });

  it('opens the save dialog only for intentional non-empty composer text', async () => {
    act(() => root.render(createElement(OrchestratorPromptControls, {
      active: true,
      repoPath: '/repos/o8',
      repoName: 'o8',
      onDraft: vi.fn(),
    })));
    act(() => window.dispatchEvent(new CustomEvent(SAVE_PROMPT_LIBRARY_EVENT, {
      detail: { body: '   ' },
    })));
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 20)); });
    expect(document.querySelector('[aria-label="Save prompt"]')).toBeNull();

    act(() => window.dispatchEvent(new CustomEvent(SAVE_PROMPT_LIBRARY_EVENT, {
      detail: { body: 'Run the release security checks.' },
    })));
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 20)); });

    expect(document.querySelector('[aria-label="Save prompt"]')).not.toBeNull();
    const saveButton = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.textContent === 'Save prompt');
    await act(async () => saveButton?.click());
    await act(async () => { await Promise.resolve(); });
    expect(fetch).toHaveBeenCalledWith('/api/prompt-library', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('Run the release security checks.'),
    }));
    expect(document.body.textContent).toContain('Prompt saved.');
  });
});
