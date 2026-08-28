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

const values = {
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
});
