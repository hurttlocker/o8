// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ComposerArea } from './ComposerArea';

vi.mock('../InputButtons', () => ({ InputButtons: ({ inlineLeadingExtras, onSubmit }: { inlineLeadingExtras?: React.ReactNode; onSubmit: () => void }) => createElement('footer', null, inlineLeadingExtras, createElement('button', { onClick: onSubmit }, 'Send')) }));
vi.mock('./SlashCommandPicker', () => ({ SlashCommandPicker: () => null }));
vi.mock('./ComposerStatusBar', () => ({ ComposerStatusBar: () => null }));
vi.mock('../../composer-center-registry', () => ({ registerComposerCenter: () => () => {} }));

const steer = vi.fn(); const queue = vi.fn();
let host: HTMLDivElement; let root: Root;
function Harness({ canSteer }: { canSteer: boolean }) {
  const [input, setInput] = useState('Use the smaller change');
  return createElement(ComposerArea, { input, onInputChange: setInput, isOrchestratorMode: true,
    displayWaiting: true, chatMessages: [], activeTargetLabel: 'Agent', targetAgentExists: true,
    thoughtsBodyBackground: 'transparent', enhancing: false, preEnhanceInput: null, onEnhance: () => {}, onUndoEnhance: () => {},
    onSubmit: queue, onSteer: steer, canSteerLive: canSteer, onSlashCommand: () => {}, modelLabel: 'Agent',
    effort: 'low', onEffortChange: () => {}, adaptiveEnabled: false, displayMessagesCount: 2, hasAssistantActivity: true });
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  steer.mockClear(); queue.mockClear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const enter = async (options: KeyboardEventInit = {}) => act(async () => host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options })));

it('defaults to Steer when live input is supported and Enter uses the live path', async () => {
  await act(async () => root.render(createElement(Harness, { canSteer: true })));
  expect(host.querySelector('textarea')!.placeholder).toBe('Steer the agent…');
  expect(host.textContent).not.toMatch(/Send next|Live steering is unavailable/);
  await enter(); expect(steer).toHaveBeenCalledOnce(); expect(queue).not.toHaveBeenCalled();
});
it('toggles a quiet footer label to Queue by click or shortcut without consuming the draft', async () => {
  await act(async () => root.render(createElement(Harness, { canSteer: true })));
  const mode = host.querySelector<HTMLButtonElement>('[aria-label="Message mode: Steer"]')!;
  expect(mode?.textContent).toBe('Steer'); expect(mode?.title).toContain('Shift+Enter');
  await act(async () => mode.click());
  expect(host.querySelector('textarea')!.placeholder).toBe('Queue for the next turn…');
  await enter(); expect(queue).toHaveBeenCalledOnce(); expect(steer).not.toHaveBeenCalled();
  await enter({ metaKey: true, shiftKey: true });
  expect(host.querySelector('[aria-label="Message mode: Steer"]')).not.toBeNull();
  expect(host.querySelector('textarea')!.value).toBe('Use the smaller change');
});
it('uses Queue without a toggle, disabled steering action or unavailable sentence when live input is unsupported', async () => {
  await act(async () => root.render(createElement(Harness, { canSteer: false })));
  expect(host.querySelector('textarea')!.placeholder).toBe('Queue for the next turn…');
  expect(host.querySelector('[aria-label^="Message mode:"]')).toBeNull();
  expect(host.textContent).not.toMatch(/Steer now|Live steering is unavailable|Send next/);
  await enter(); expect(queue).toHaveBeenCalledOnce(); expect(steer).not.toHaveBeenCalled();
});
