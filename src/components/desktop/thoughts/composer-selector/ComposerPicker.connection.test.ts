// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ComposerPicker } from './ComposerPicker';
import { resolveComposerSelectorState } from './state';
import { COMPOSER_MODEL_GROUPS } from '../ModelThinkingChip';
import { invalidateRuntimeInventory } from '../../onboarding/useRuntimeInventory';

vi.mock('../chat-panel/ComposerPopover', () => ({
  ComposerPopover: ({ open, children }: { open: boolean; children: unknown }) => open ? children : null,
}));

it('shows connection provenance before selecting a model without changing saved defaults', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  invalidateRuntimeInventory();
  const fetcher = vi.fn(async () => Response.json({
    values: {}, sources: {}, dispatchableRuntimes: [{ id: 'codex', label: 'Codex', installed: true, available: true,
      unavailableReason: null, detail: '', fix: '', connection: {
        state: 'observed', providers: ['OpenAI'], observations: [{ source: 'cli_report', outcome: 'present' }],
        checkedAt: Date.parse('2026-10-18T20:00:00Z'), account: 'not_reported', externalTools: 'not_inspected',
      } }],
  }));
  vi.stubGlobal('fetch', fetcher);
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  try {
    const state = resolveComposerSelectorState({ mode: 'solo', leadModelId: 'gpt-5.6-sol', leadModelLabel: 'Codex',
      leadBackend: 'codex', inSessionEffortByModel: {}, threadEffortByModel: {}, operatorDefaultEffort: 'high', adaptiveEnabled: false });
    await act(async () => root.render(createElement(ComposerPicker, {
      state, composerModelGroups: COMPOSER_MODEL_GROUPS, onEffortChange: vi.fn(),
    })));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-lead"]')!.click());
    const evidence = container.querySelector('[data-testid="runtime-connection-evidence"]');
    expect(evidence?.textContent).toContain('OpenAI');
    expect(evidence?.textContent).toContain('CLI report: present');
    expect(evidence?.textContent).toContain('2026-10-18T20:00:00.000Z');
    expect(fetcher.mock.calls.some((call: unknown[]) => (call[1] as RequestInit)?.method === 'POST')).toBe(false);
  } finally {
    act(() => root.unmount()); container.remove(); invalidateRuntimeInventory(); vi.unstubAllGlobals();
  }
});
