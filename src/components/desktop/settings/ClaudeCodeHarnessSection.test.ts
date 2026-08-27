// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClaudeCodeHarnessSection } from './ClaudeCodeHarnessSection';

describe('ClaudeCodeHarnessSection', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('projects the selected gateway model and separate billing truth in Settings', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      ok: true,
      profile: { source: 'openrouter', model: 'deepseek/deepseek-v4-pro-0813', codexModel: null },
      effectiveModel: 'deepseek/deepseek-v4-pro-0813',
      openrouterConfigured: true,
      billing: 'api',
      codexSubscriptionSupported: true,
      codexSubscriptionReason: 'A localhost proxy can route Claude Code through Codex OAuth.',
      codexProxy: { installed: true, authenticated: true, running: true, connecting: false, modelCount: 3 },
    })));

    await act(async () => {
      root.render(createElement(ClaudeCodeHarnessSection));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain('Claude Code harness');
    expect(container.textContent).toContain('deepseek/deepseek-v4-pro-0813');
    expect(container.textContent).toContain('API billed');
    expect(container.textContent).toContain('Codex subscription');
  });

  it('starts the browser OAuth flow for the Codex subscription carrier', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/runtime/claude-code-codex') && init?.method === 'POST') {
        return Response.json({
          ok: true,
          status: { installed: true, authenticated: false, running: false, connecting: true, modelCount: 0 },
        }, { status: 202 });
      }
      return Response.json({
        ok: true,
        profile: { source: 'codex-subscription', model: null, codexModel: 'gpt-5.6-sol' },
        effectiveModel: 'gpt-5.6-sol',
        openrouterConfigured: false,
        billing: 'codex-subscription',
        codexSubscriptionSupported: true,
        codexSubscriptionReason: 'A localhost proxy can route Claude Code through Codex OAuth.',
        codexProxy: { installed: true, authenticated: false, running: false, connecting: false, modelCount: 0 },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(createElement(ClaudeCodeHarnessSection));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const connect = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Connect Codex');
    expect(connect).toBeDefined();
    await act(async () => {
      connect!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/runtime/claude-code-codex', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ action: 'connect' }),
    }));
    expect(container.textContent).toContain('Waiting for browser…');
  });

  it('does not offer the API-billed carrier before its key is configured', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      ok: true,
      profile: { source: 'native', model: null, codexModel: null },
      effectiveModel: null,
      openrouterConfigured: false,
      billing: 'provider-account',
      codexSubscriptionSupported: true,
      codexSubscriptionReason: 'A localhost proxy can use an existing subscription.',
      codexProxy: { installed: true, authenticated: true, running: true, connecting: false, modelCount: 3 },
    })));

    await act(async () => {
      root.render(createElement(ClaudeCodeHarnessSection));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const sourcePicker = container.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]');
    expect(sourcePicker).not.toBeNull();
    await act(async () => {
      sourcePicker!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const options = Array.from(document.body.querySelectorAll('[role="option"]'))
      .map((option) => option.textContent);
    expect(options).toContain('Native accountUse the existing Claude Code login or inherited gateway.');
    expect(options).toContain('Codex subscriptionRoute Claude Code through a localhost Codex OAuth carrier.');
    expect(options.some((option) => option?.includes('OpenRouter'))).toBe(false);
  });
});
