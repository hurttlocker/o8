/** @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClaudeWorkerSkills } from './ClaudeWorkerSkills';

describe('ClaudeWorkerSkills', () => {
  let host: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return Response.json({
          ok: true,
          profile: { repoSkillAllowlist: ['review-only', 'security_audit'] },
        });
      }
      return Response.json({
        ok: true,
        profile: { repoSkillAllowlist: ['review-only'] },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function settle() {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }

  it('explains global worker-only behavior and patches only the allowlist', async () => {
    await act(async () => {
      root.render(createElement(ClaudeWorkerSkills));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain('global list applies across repositories');
    expect(host.textContent).toContain('only affects dispatched Claude Code workers');
    expect(host.textContent).toContain('Missing skills are skipped');

    const input = host.querySelector<HTMLInputElement>('input[aria-label="Claude Code worker skill names"]');
    expect(input?.value).toBe('review-only');
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(input, 'review-only, security_audit');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Save');
    await act(async () => { save?.click(); });
    await settle();

    expect(fetchMock).toHaveBeenLastCalledWith('/api/runtime/claude-code-profile', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ repoSkillAllowlist: ['review-only', 'security_audit'] }),
    }));
  });

  it('keeps editing disabled when the current profile cannot be loaded', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({
      ok: false,
      error: { message: 'Profile unavailable.' },
    }, { status: 503 }));

    await act(async () => {
      root.render(createElement(ClaudeWorkerSkills));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.querySelector<HTMLInputElement>('input')?.disabled).toBe(true);
    expect([...host.querySelectorAll('button')].find((button) => button.textContent === 'Save')?.disabled).toBe(true);
    expect(host.textContent).toContain('Profile unavailable.');
  });
});
