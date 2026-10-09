// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SendPill } from './ComposerSendControl';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('sends only when armed and switches the same control to stop while working', () => {
  const submit = vi.fn(); const stop = vi.fn();
  act(() => root.render(createElement(SendPill, { canSubmit: false, working: false, onSubmit: submit, onStop: stop })));
  const button = container.querySelector('button')!;
  act(() => button.click());
  expect(submit).not.toHaveBeenCalled();
  act(() => root.render(createElement(SendPill, { canSubmit: true, working: false, onSubmit: submit, onStop: stop })));
  act(() => button.click());
  expect(submit).toHaveBeenCalledTimes(1);
  act(() => root.render(createElement(SendPill, { canSubmit: true, working: true, onSubmit: submit, onStop: stop })));
  expect(button.getAttribute('aria-label')).toBe('Stop orchestrator');
  act(() => button.click());
  expect(stop).toHaveBeenCalledTimes(1);
  expect(submit).toHaveBeenCalledTimes(1);
  act(() => root.render(createElement(SendPill, { canSubmit: true, working: true, onSubmit: submit })));
  expect(button.disabled).toBe(true);
  act(() => button.click());
  expect(submit).toHaveBeenCalledTimes(1);
});

it('keeps pointer feedback still for reduced motion', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  act(() => root.render(createElement(SendPill, { canSubmit: true, working: false, onSubmit: () => {} })));
  act(() => container.querySelector('button')!.dispatchEvent(new Event('pointerdown', { bubbles: true })));
  expect(container.querySelector('svg')!.style.transform).toBe('');
});
