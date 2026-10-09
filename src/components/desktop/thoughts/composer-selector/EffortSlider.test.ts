// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EffortSlider } from './EffortSlider';
import { resolveComposerSelectorState } from './state';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const pick = vi.fn();
const state = resolveComposerSelectorState({ mode: 'solo', leadBackend: 'codex', leadModelId: 'gpt-6-astra', leadModelLabel: 'Astra', inSessionEffortByModel: {}, threadEffortByModel: {}, operatorDefaultEffort: 'high', adaptiveEnabled: true });
beforeEach(() => {
  pick.mockClear(); container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  act(() => root.render(createElement(EffortSlider, { state, onPick: pick })));
  const slider = container.querySelector<HTMLElement>('[role="slider"]')!;
  vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 200 } as DOMRect);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const pointer = (type: string, clientX: number) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0, buttons: type === 'pointerup' ? 0 : 1 });

it('previews a drag and commits only the released stop', () => {
  const slider = container.querySelector<HTMLElement>('[role="slider"]')!;
  act(() => slider.dispatchEvent(pointer('pointerdown', 0)));
  act(() => slider.dispatchEvent(pointer('pointermove', 100)));
  act(() => slider.dispatchEvent(pointer('pointermove', 200)));
  expect(slider.getAttribute('aria-valuetext')).toBe('Max');
  expect(pick).not.toHaveBeenCalled();
  act(() => slider.dispatchEvent(pointer('pointerup', 200)));
  expect(pick).toHaveBeenCalledExactlyOnceWith('max');
});

it('cancels without changing effort and responds to keyboard input immediately', () => {
  const slider = container.querySelector<HTMLElement>('[role="slider"]')!;
  act(() => slider.dispatchEvent(pointer('pointerdown', 0)));
  act(() => slider.dispatchEvent(pointer('pointercancel', 0)));
  expect(pick).not.toHaveBeenCalled();
  expect(slider.getAttribute('aria-valuetext')).toBe('High');
  act(() => slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
  expect(pick).toHaveBeenCalledExactlyOnceWith('low');
});

it('honors reduced motion and locked effort levels', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const animate = vi.fn();
  act(() => root.render(createElement(EffortSlider, { key: 'reduced-motion', state: { ...state, lockedEffortOptions: ['max'] }, onPick: pick })));
  Object.defineProperty(container.querySelector('[data-testid="composer-selector-slider-fill"]')!, 'animate', { value: animate });
  const slider = container.querySelector<HTMLElement>('[role="slider"]')!;
  vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 200 } as DOMRect);
  act(() => slider.dispatchEvent(pointer('pointerdown', 200)));
  act(() => slider.dispatchEvent(pointer('pointerup', 200)));
  expect(pick).not.toHaveBeenCalled();
  act(() => slider.dispatchEvent(pointer('pointerdown', 0)));
  act(() => slider.dispatchEvent(pointer('pointerup', 0)));
  expect(pick).toHaveBeenCalledExactlyOnceWith('low');
  expect(animate).not.toHaveBeenCalled();
});
