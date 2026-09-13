// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/entitlement/context', () => ({
  useEntitlement: () => ({ plan: 'free' }),
}));

vi.mock('./LocalModelsSection', () => ({ LocalModelsSection: () => null }));

import { DispatchFoundersSection } from './DispatchFoundersSection';
import {
  ORCHESTRATOR_THINKING_PREFERENCES_EVENT,
  ORCHESTRATOR_ULTRA_EFFORT_STORAGE_KEY,
} from '@/lib/orchestrator/thinking-preferences';
import type { OperatorDefaults, OperatorDefaultSources } from './dispatch-shared';
import { THINKING_EFFORT_OPTIONS } from './dispatch-shared';
import { THINKING_EFFORT_LABELS } from '@/lib/orchestrator/thinking-effort';

const values = {
  thinkingEffort: 'xhigh',
  targetingTriage: { runtime: 'codex', model: '', effort: 'low' },
  targetingAction: { runtime: 'codex', model: '', effort: 'low' },
} as OperatorDefaults;
const sources = {} as OperatorDefaultSources;

describe('DispatchFoundersSection Ultra effort setting', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('writes the Ultra preference and notifies live picker subscribers', async () => {
    const listener = vi.fn();
    window.addEventListener(ORCHESTRATOR_THINKING_PREFERENCES_EVENT, listener);

    await act(async () => {
      root.render(createElement(DispatchFoundersSection, {
        values,
        sources,
        busyField: null,
        updateField: vi.fn(),
        showExperimental: false,
      }));
    });

    const ultraSwitch = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="switch"]'))[1];
    expect(container.textContent).toContain('Show Ultra effort');
    expect(ultraSwitch).toBeDefined();

    await act(async () => {
      ultraSwitch.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(window.localStorage.getItem(ORCHESTRATOR_ULTRA_EFFORT_STORAGE_KEY)).toBe('1');
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(ORCHESTRATOR_THINKING_PREFERENCES_EVENT, listener);
  });

  it('renders every Settings effort option from the shared label table', async () => {
    await act(async () => {
      root.render(createElement(DispatchFoundersSection, {
        values,
        sources,
        busyField: null,
        updateField: vi.fn(),
        showExperimental: false,
      }));
    });
    const effortPicker = container.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!;
    expect(effortPicker.textContent).toContain(THINKING_EFFORT_LABELS.xhigh.long);
    await act(async () => { effortPicker.click(); });
    const rendered = document.body.textContent ?? '';
    for (const option of THINKING_EFFORT_OPTIONS) {
      expect(option.label).toBe(THINKING_EFFORT_LABELS[option.value].long);
      expect(rendered).toContain(option.label);
    }
  });
});
