// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingReposStep } from './OnboardingReposStep';
import type { OnboardingRequest } from './request';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

function findButton(container: HTMLElement, label: string): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll('button'))
    .find((candidate) => candidate.textContent === label) ?? null;
}

describe('OnboardingReposStep source folder picker', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('fails promptly without browsing when source web cannot open a native picker', async () => {
    const request = vi.fn<OnboardingRequest>(async (input) => {
      if (String(input) === '/api/panel/github-status') {
        return Response.json({ authenticated: false });
      }
      return new Promise<Response>(() => undefined);
    });

    await act(async () => {
      root.render(createElement(OnboardingReposStep, {
        request,
        deviceFlowEnabled: false,
        githubFlow: { stage: 'idle' },
        onConnectGithub: vi.fn(),
        onSkip: vi.fn(),
        onContinue: vi.fn(),
        renderContinueButton: ({ label, onClick, disabled }) => createElement('button', {
          type: 'button',
          onClick,
          disabled,
        }, label),
      }));
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });

    const chooseButton = findButton(container, 'Choose a folder on this Mac');
    expect(chooseButton).not.toBeNull();
    const startedAt = performance.now();
    act(() => chooseButton!.click());

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(container.textContent).toContain('The native o8 shell is required');
    expect(container.textContent).toContain('npm run build:cli');
    expect(container.textContent).toContain('node cli/dist/o8.mjs repo add /absolute/path');
    expect(chooseButton?.disabled).toBe(false);
    expect(request.mock.calls.some(([input]) => String(input) === '/api/panel/browse-folder')).toBe(false);
  });
});
