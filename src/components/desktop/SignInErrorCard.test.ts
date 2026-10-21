// @vitest-environment jsdom

import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignInErrorCard } from './SignInErrorCard';
import {
  clearDesktopAuthError,
  getDesktopAuthError,
  reportDesktopAuthError,
} from '@/lib/auth/desktop-auth-error';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

describe('SignInErrorCard reason disclosure', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    clearDesktopAuthError();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    clearDesktopAuthError();
  });

  it('binds two independent disclosures to unique details and preserves identity across collapse', () => {
    const currentError = reportDesktopAuthError('First static failure');
    const onRetry = vi.fn();
    act(() => root.render(createElement(Fragment, null,
      createElement(SignInErrorCard, { authError: currentError }),
      createElement(SignInErrorCard, { authError: { id: 200, message: 'Second static failure' } }),
      createElement(SignInErrorCard, { authError: currentError, onRetry }),
    )));
    const buttons = container.querySelectorAll<HTMLButtonElement>('[role="status"] > div > button:first-child');
    const first = buttons[0];
    const second = buttons[1];
    expect(first.textContent).toContain('Show reason');
    expect(second.textContent).toContain('Show reason');

    act(() => first.click());
    act(() => second.click());
    const firstId = first.getAttribute('aria-controls');
    const secondId = second.getAttribute('aria-controls');
    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    expect(firstId).not.toBe(secondId);
    expect(document.getElementById(firstId!)?.textContent).toBe('First static failure');
    expect(document.getElementById(secondId!)?.textContent).toBe('Second static failure');
    expect(first.getAttribute('aria-expanded')).toBe('true');
    expect(second.getAttribute('aria-expanded')).toBe('true');

    act(() => first.click());
    expect(first.getAttribute('aria-expanded')).toBe('false');
    expect(first.textContent).toContain('Show reason');
    expect(document.getElementById(firstId!)).toBeNull();
    expect(document.getElementById(secondId!)?.textContent).toBe('Second static failure');
    expect(second.getAttribute('aria-expanded')).toBe('true');

    act(() => first.click());
    expect(first.getAttribute('aria-controls')).toBe(firstId);
    expect(document.getElementById(firstId!)?.textContent).toBe('First static failure');
    expect(onRetry).not.toHaveBeenCalled();
    expect(getDesktopAuthError()).toEqual(currentError);
  });

  it('keeps the retry action distinct from a disclosure and clears only on activation', () => {
    const currentError = reportDesktopAuthError('Retryable static failure');
    const onRetry = vi.fn();
    act(() => root.render(createElement(SignInErrorCard, { authError: currentError, onRetry })));
    const primary = container.querySelector<HTMLButtonElement>('button')!;
    expect(primary.textContent).toContain('Retryable static failure');
    expect(primary.hasAttribute('aria-controls')).toBe(false);
    expect(primary.hasAttribute('aria-expanded')).toBe(false);
    expect(onRetry).not.toHaveBeenCalled();
    expect(getDesktopAuthError()).toEqual(currentError);

    act(() => primary.click());
    expect(onRetry).toHaveBeenCalledOnce();
    expect(getDesktopAuthError()).toBeNull();
    expect(container.querySelector('[aria-expanded="true"]')).toBeNull();
  });

  it('dismisses the error without starting a retry', () => {
    const currentError = reportDesktopAuthError('Dismissible static failure');
    const onRetry = vi.fn();
    act(() => root.render(createElement(SignInErrorCard, { authError: currentError, onRetry })));
    const dismiss = container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss sign-in error"]')!;
    act(() => dismiss.click());
    expect(getDesktopAuthError()).toBeNull();
    expect(onRetry).not.toHaveBeenCalled();
  });
});
