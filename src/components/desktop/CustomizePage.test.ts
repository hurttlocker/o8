/** @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomizePage } from './CustomizePage';

describe('CustomizePage skills', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/panel/repos') {
        return Response.json({ repos: [{ name: 'o8', localPath: '/repo/o8' }] });
      }
      if (url.startsWith('/api/customize/inventory')) {
        return Response.json({
          ok: true,
          agents: [],
          hooks: [],
          skills: [
            { name: 'review', description: 'Shared review', scope: 'project', source: 'shared', file: '/repo/o8/.agents/skills/review/SKILL.md' },
            { name: 'visual-check', description: 'Gemini visual checks', scope: 'user', source: 'gemini', file: '/home/.gemini/skills/visual-check/SKILL.md' },
          ],
        });
      }
      if (url === '/api/cortex/directives') return Response.json({ directives: [] });
      if (url === '/api/setup/mcp-servers') return Response.json({ servers: [] });
      if (url.startsWith('/api/prompt-library')) return Response.json({ prompts: [] });
      return Response.json({}, { status: 404 });
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('reaches the universal inventory through Skills and searches its metadata', async () => {
    await act(async () => {
      root.render(createElement(CustomizePage));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const skillsTab = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.startsWith('Skills'));
    act(() => skillsTab?.click());
    expect(host.textContent).toContain('Discovered skills');
    expect(host.textContent).toContain('review');
    expect(host.textContent).toContain('visual-check');
    expect(skillsTab?.textContent).toContain('2');

    const search = host.querySelector<HTMLInputElement>('input[placeholder^="Search Skills"]');
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(search, 'gemini');
      search?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(host.textContent).toContain('visual-check');
    expect(host.textContent).not.toContain('Shared review');
  });

  it('shows unavailable inventory instead of claiming no skills when loading fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/panel/repos') return Response.json({ repos: [] });
      return Response.json({}, { status: 503 });
    }));
    await act(async () => {
      root.render(createElement(CustomizePage));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const skillsTab = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.startsWith('Skills'));
    act(() => skillsTab?.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not load');
    expect(host.textContent).not.toContain('No skills discovered');
  });

});
