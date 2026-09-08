// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchOperatorDefaultsMock } = vi.hoisted(() => ({
  fetchOperatorDefaultsMock: vi.fn(),
}));

vi.mock('./operator-defaults-client', () => ({
  fetchOperatorDefaults: fetchOperatorDefaultsMock,
}));

import { SymonAttentionSettingsSection } from './SymonAttentionSettingsSection';
import { searchSettings, SETTINGS_SEARCH_REGISTRY } from './settings-search';

const values = {
  broadcastCommentary: 'interval',
  broadcastVoice: 'on',
  broadcastCommentaryMaxPerHour: 8,
  broadcastVoiceLullMinutes: 10,
  broadcastVoiceQuietHours: 'on',
  broadcastVoiceQuietStart: '21:30',
  broadcastVoiceQuietEnd: '07:15',
  broadcastVoiceAttention: true,
  broadcastVoiceApprovals: true,
  broadcastVoiceReviews: true,
  broadcastVoiceFailures: true,
  broadcastVoiceCompletions: true,
  broadcastVoiceCalendar: true,
  broadcastVoiceCalendarLeadMinutes: 20,
  broadcastVoiceTimeCheckins: true,
} as const;

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('Symon proactive attention settings', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    fetchOperatorDefaultsMock.mockReset().mockResolvedValue(Response.json({ values }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('surfaces the full policy and persists the Calendar subscription', async () => {
    await act(async () => {
      root.render(createElement(SymonAttentionSettingsSection));
      await settle();
    });

    expect(container.textContent).toContain('Proactive attention');
    expect(container.textContent).toContain('Quiet hours');
    expect(container.textContent).toContain('Calendar events');
    expect(container.textContent).toContain('use Automations for scheduled summaries');
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Calendar alert lead time in minutes"]')?.value)
      .toBe('20');

    const calendarRow = [...container.querySelectorAll('div')]
      .find((element) => element.textContent?.startsWith('Calendar events'));
    const toggle = calendarRow?.querySelector<HTMLButtonElement>('button[role="switch"]');
    expect(toggle?.getAttribute('aria-checked')).toBe('true');
    fetchOperatorDefaultsMock.mockResolvedValueOnce(Response.json({
      values: { ...values, broadcastVoiceCalendar: false },
    }));
    await act(async () => {
      toggle?.click();
      await settle();
    });
    expect(fetchOperatorDefaultsMock.mock.calls[1]?.[0]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ broadcastVoiceCalendar: false }),
    });
  });

  function toggleFor(label: string): HTMLButtonElement {
    const row = [...container.querySelectorAll('div')]
      .find((element) => element.textContent?.startsWith(label));
    const toggle = row?.querySelector<HTMLButtonElement>('button[role="switch"]');
    expect(toggle).toBeTruthy();
    return toggle!;
  }

  it.each([
    ['interval', 'off', 'true', 'false'],
    ['off', 'interval', 'false', 'true'],
  ] as const)('changes commentary from %s to %s independently of spoken updates', async (from, to, before, after) => {
    const current = { ...values, broadcastCommentary: from, broadcastVoice: 'off' };
    fetchOperatorDefaultsMock.mockResolvedValue(Response.json({ values: current }));
    await act(async () => {
      root.render(createElement(SymonAttentionSettingsSection));
      await settle();
    });
    const toggle = toggleFor('Automatic AI commentary');
    expect(toggle.getAttribute('aria-label')).toBe('Automatic AI commentary');
    expect(toggle.getAttribute('aria-checked')).toBe(before);
    expect(toggle.disabled).toBe(false);
    expect(container.textContent).toContain('model allowance');
    expect(container.textContent).toContain('keeps messages and approvals available');
    fetchOperatorDefaultsMock.mockImplementation(async () => Response.json({
      values: { ...current, broadcastCommentary: to },
    }));
    await act(async () => {
      toggle.click();
      await settle();
    });
    expect(fetchOperatorDefaultsMock.mock.calls[1]?.[0]).toMatchObject({
      method: 'POST', body: JSON.stringify({ broadcastCommentary: to }),
    });
    expect(toggle.getAttribute('aria-checked')).toBe(after);
    expect(toggleFor('Spoken updates').getAttribute('aria-checked')).toBe('false');

    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(SymonAttentionSettingsSection));
      await settle();
    });
    expect(toggleFor('Automatic AI commentary').getAttribute('aria-checked')).toBe(after);
  });

  it('restores the saved commentary state and reports a failed save', async () => {
    await act(async () => {
      root.render(createElement(SymonAttentionSettingsSection));
      await settle();
    });
    fetchOperatorDefaultsMock.mockResolvedValueOnce(Response.json({ error: 'Save failed.' }, { status: 503 }));
    await act(async () => {
      toggleFor('Automatic AI commentary').click();
      await settle();
    });
    expect(toggleFor('Automatic AI commentary').getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Save failed.');
  });

  it('makes commentary discoverable in Settings search', () => {
    expect(searchSettings(SETTINGS_SEARCH_REGISTRY, 'automatic commentary', { founder: false }))
      .toContainEqual(expect.objectContaining({ tab: 'voice', label: 'Automatic AI commentary' }));
  });
});
