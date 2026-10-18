// @vitest-environment jsdom
import { act, createElement, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { SettingsTab } from './shared';
import type { NavSection } from '@/app/dashboard/types';
import { useSettingsSectionNavigation } from './useSettingsSectionNavigation';
import { useSettingsOverlayDismiss } from '@/app/dashboard/hooks/useSettingsOverlayDismiss';

it('returns through visited Settings pages and preserves the forward branch until a new visit', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  function Fixture() {
    const [tab, setTab] = useState<SettingsTab>('general');
    const nav = useSettingsSectionNavigation(tab, setTab);
    return createElement('div', null,
      createElement('p', null, tab),
      ...(['appearance', 'voice'] as SettingsTab[]).map(next => createElement('button', { key: next, onClick: () => nav.navigate(next) }, next)),
      createElement('button', { onClick: nav.back }, 'Back'),
      createElement('button', { onClick: nav.forward, disabled: !nav.canForward }, 'Forward'));
  }
  const click = async (label: string) => act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === label)!.click());
  try {
    await act(async () => root.render(createElement(Fixture)));
    await click('appearance'); await click('voice'); await click('Back');
    expect(host.querySelector('p')!.textContent).toBe('appearance');
    await click('Back'); expect(host.querySelector('p')!.textContent).toBe('general');
    await click('Forward'); expect(host.querySelector('p')!.textContent).toBe('appearance');
    await click('voice'); expect(host.querySelector<HTMLButtonElement>('button:last-child')!.disabled).toBe(true);
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

it('returns from Settings to the destination that opened it', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  function Fixture() {
    const [section, setActiveNavSection] = useState<NavSection>('projects'); const panelRef = useRef<HTMLDivElement>(null);
    const { toggleSettingsOverlay, closeSettingsOverlay } = useSettingsOverlayDismiss({ activeNavSection: section, panelRef, setActiveNavSection });
    return createElement('div', null, createElement('p', null, section), createElement('button', { onClick: toggleSettingsOverlay }, 'Settings'), createElement('button', { onClick: closeSettingsOverlay }, 'Close'));
  }
  try {
    await act(async () => root.render(createElement(Fixture)));
    await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
    expect(host.querySelector('p')!.textContent).toBe('settings');
    await act(async () => host.querySelector<HTMLButtonElement>('button:last-child')!.click());
    expect(host.querySelector('p')!.textContent).toBe('projects');
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
