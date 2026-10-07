// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
const cue = vi.hoisted(() => vi.fn());
vi.mock('./onboarding-sound', async (original) => ({ ...await original<typeof import('./onboarding-sound')>(), playOnboardingCue: cue }));
import { OnboardingExperience, OnboardingSoundToggle, useOnboardingMotion } from './OnboardingExperience';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
afterEach(() => { act(() => root?.unmount()); document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate); else Reflect.deleteProperty(HTMLElement.prototype, 'animate'); });
function Subject() {
  const [step, setStep] = useState('one');
  const ref = useOnboardingMotion(step);
  return createElement('div', null, createElement('button', { onClick: () => setStep((current) => current === 'one' ? 'two' : 'one') }, 'Next'), createElement('div', { ref }, step), createElement(OnboardingSoundToggle));
}
async function render(reduced = false) {
  const cancel = vi.fn();
  const animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => ({ cancel }));
  const media = { matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal('matchMedia', () => media as unknown as MediaQueryList);
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
  const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root.render(createElement(OnboardingExperience, { storage: localStorage }, createElement(Subject))));
  return { animate, cancel, media, button: document.querySelector('button')! };
}

it('animates a pointer step once, keeps keyboard navigation instant, and cancels interruption', async () => {
  const { animate, cancel, button } = await render();
  expect(animate).not.toHaveBeenCalled();
  await act(async () => { button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); button.click(); });
  expect(animate).toHaveBeenCalledOnce();
  expect(animate.mock.calls[0]?.[1]).toMatchObject({ duration: 180 });
  await act(async () => { button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); button.click(); });
  expect(animate).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain('one');
});

it('skips movement in reduced motion', async () => {
  const { animate, button } = await render(true);
  await act(async () => { button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); button.click(); });
  expect(animate).not.toHaveBeenCalled();
});

it('cancels active movement when reduced motion is enabled', async () => {
  const { media, cancel, button } = await render();
  await act(async () => { button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); button.click(); });
  expect(media.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  const listener = media.addEventListener.mock.calls[0]![1] as () => void;
  listener();
  expect(cancel).toHaveBeenCalledOnce();
});

it('keeps an opted-in sound preference independent of reduced motion', async () => {
  const { media } = await render(true);
  const sound = document.querySelector<HTMLButtonElement>('[aria-label="Onboarding sounds"]')!;
  await act(async () => sound.click());
  expect(sound.getAttribute('aria-pressed')).toBe('true');
  expect(media.matches).toBe(true);
  expect(localStorage.getItem('o8:onboarding-muted')).toBe('0');
});

it('suppresses click cues and the opt-in preview while a microphone check is active', async () => {
  const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root.render(createElement(OnboardingExperience, { storage: localStorage }, createElement('div', { 'data-onboarding-sound': 'silent' }, createElement('button', null, 'Return'), createElement(OnboardingSoundToggle, { quiet: true })))));
  const sound = document.querySelector<HTMLButtonElement>('[aria-label="Onboarding sounds"]')!;
  await act(async () => sound.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
  expect(localStorage.getItem('o8:onboarding-muted')).toBe('0');
  const button = document.querySelector('button')!;
  await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })));
  expect(cue).not.toHaveBeenCalled();
});
