// @vitest-environment jsdom
import { act, createElement, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NavSection } from '@/app/dashboard/types';
import { useSettingsOverlayDismiss } from '@/app/dashboard/hooks/useSettingsOverlayDismiss';
import { PickerMenu } from './dispatch-shared';
import { SettingsNavItem } from './SettingsNavItem';
import { useSettingsSectionNavigation } from './useSettingsSectionNavigation';
import { VoiceShortcutsSection } from './VoiceShortcutsSection';
import type { SettingsTab } from './shared';

vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => true }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const scroll = vi.fn();
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  Element.prototype.scrollIntoView = scroll; scroll.mockClear();
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });

function Harness() {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [open, setOpen] = useState<SettingsTab | null>(null);
  const [nav, setNav] = useState<NavSection>('settings');
  const panelRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const { contentRef, navigate } = useSettingsSectionNavigation(activeTab, setActiveTab);
  useSettingsOverlayDismiss({ activeNavSection: nav, panelRef, setActiveNavSection: setNav });
  if (nav !== 'settings') return createElement('p', null, 'Workspace');
  // React forwards these callback refs during commit; createElement does not invoke them.
  // eslint-disable-next-line react-hooks/refs
  return createElement('div', { ref: (node: HTMLDivElement | null) => { panelRef.current = node; }, 'data-settings-shell': true },
    createElement(SettingsNavItem, { tab: 'operator-defaults', label: 'Dispatch', icon: null, active: activeTab === 'operator-defaults', openTab: open, onOpen: setOpen, onNavigate: navigate }),
    createElement('button', { onClick: () => setLoaded(true) }, 'Complete loading'),
    createElement(PickerMenu<string>, { value: 'auto', options: [{ value: 'auto', label: 'Automatic' }], onChange: () => {} }),
    // eslint-disable-next-line react-hooks/refs -- React invokes the ref during commit.
    createElement('div', { ref: (node: HTMLDivElement | null) => { contentRef.current = node; }, 'data-settings-content': true },
      activeTab === 'general' ? 'General content' : loaded
        ? createElement('details', { 'data-settings-section': 'Advanced routing' }, createElement('summary', null, 'Advanced routing'), 'Controls')
        : 'Loading dispatch'));
}

it('previews inactive sections, then waits for loaded content and opens the requested section', async () => {
  await act(async () => { root.render(createElement(Harness)); });
  await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Dispatch sections"]')!.click(); });
  expect(container.textContent).toContain('General content');
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  const target = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Advanced routing')!;
  await act(async () => { target.click(); });
  expect(container.textContent).toContain('Loading dispatch');
  await act(async () => { [...container.querySelectorAll('button')].find((button) => button.textContent === 'Complete loading')!.click(); });
  const details = container.querySelector('details')!;
  expect(details.open).toBe(true);
  expect(document.activeElement).toBe(details);
  expect(scroll).toHaveBeenCalledWith({ block: 'start', behavior: 'instant' });
});

it('opens a hover preview without activating the page', async () => {
  await act(async () => { root.render(createElement(Harness)); });
  const button = [...container.querySelectorAll('button')].find((element) => element.textContent === 'Dispatch')!;
  await act(async () => {
    button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 220));
  });
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(container.textContent).toContain('General content');
});

it('Escape dismisses the section menu before dismissing Settings', async () => {
  await act(async () => { root.render(createElement(Harness)); });
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Dispatch sections"]')!;
  await act(async () => { trigger.click(); });
  await act(async () => { trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
  expect(document.activeElement?.textContent).toBe('Fleet');
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).toContain('General content');
  expect(document.activeElement).toBe(trigger);
  await act(async () => { trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(container.textContent).toBe('Workspace');
});

it('keeps Voice quick tips collapsed until requested', async () => {
  await act(async () => { root.render(createElement(VoiceShortcutsSection, { externalFnActive: true })); });
  expect(container.querySelector('details')!.open).toBe(false);
  expect(container.textContent).toContain('Fn or Left Control');
  expect(container.textContent).toContain('Hold Control + Z in o8');
});

it('Escape closes a body-portaled provider picker before closing Settings', async () => {
  await act(async () => { root.render(createElement(Harness)); });
  const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!;
  await act(async () => { trigger.click(); });
  expect(document.body.querySelector('[role="listbox"]')).not.toBeNull();
  expect(container.querySelector('[role="listbox"]')).toBeNull();
  await act(async () => { trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(document.body.querySelector('[role="listbox"]')).toBeNull();
  expect(container.textContent).toContain('General content');
  expect(document.activeElement).toBe(trigger);
  await act(async () => { trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(container.textContent).toBe('Workspace');
});
