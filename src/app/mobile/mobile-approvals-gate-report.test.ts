// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileGateReport } from './mobile-approvals-approvals-view';
import { getMobilePalette, type ApprovalItem } from './mobile-approvals-shared';

const approval: ApprovalItem = {
  id: 'gate-report-fixture',
  title: 'Review changes',
  risk: 'high',
  status: 'pending',
  createdAt: 0,
  gateResult: {
    passed: false,
    violations: [
      { category: 'integrity', severity: 'block', label: 'Tests failed', detail: 'Check results' },
      { category: 'security', severity: 'warn', label: 'Review access', detail: 'Check access' },
    ],
  },
};

describe('mobile approval gate report disclosure', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it.each(['light', 'dark'])('links independent reports to their violations in %s', async (theme) => {
    const palette = getMobilePalette(theme);
    await act(async () => root.render(createElement('div', null,
      createElement(MobileGateReport, { approval, palette }),
      createElement(MobileGateReport, { approval, palette }),
    )));
    const buttons = Array.from(host.querySelectorAll('button'));
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(button.getAttribute('aria-controls')).toBeNull();
      expect(button.style.minHeight).toBe('44px');
      expect(button.textContent).toContain('Gate: 1 block, 1 warn');
      await act(async () => button.click());
    }

    const ids = buttons.map((button) => {
      expect(button.getAttribute('aria-expanded')).toBe('true');
      const id = button.getAttribute('aria-controls');
      expect(id).toBeTruthy();
      const region = document.getElementById(id!);
      expect(region).not.toBeNull();
      expect(button.parentElement?.contains(region)).toBe(true);
      expect(region?.textContent).toContain('Tests failed');
      expect(region?.textContent).toContain('Review access');
      return id!;
    });
    expect(new Set(ids).size).toBe(2);

    await act(async () => buttons[0].click());
    expect(buttons[0].getAttribute('aria-expanded')).toBe('false');
    expect(buttons[0].getAttribute('aria-controls')).toBeNull();
    expect(document.getElementById(ids[0])).toBeNull();
    expect(document.getElementById(ids[1])).not.toBeNull();
    await act(async () => buttons[0].click());
    expect(buttons[0].getAttribute('aria-controls')).toBe(ids[0]);
    expect(document.getElementById(ids[0])).not.toBeNull();
  });

  it.each([undefined, { passed: true, violations: [] }])('renders nothing for gate result %j', async (gateResult) => {
    const palette = getMobilePalette('light');
    await act(async () => root.render(createElement(MobileGateReport, {
      approval: { ...approval, gateResult }, palette,
    })));
    expect(host.childElementCount).toBe(0);
    // Gate data can arrive after the approval, so hooks must remain stable.
    await act(async () => root.render(createElement(MobileGateReport, { approval, palette })));
    expect(host.querySelector('button')).not.toBeNull();
    await act(async () => root.render(createElement(MobileGateReport, {
      approval: { ...approval, gateResult }, palette,
    })));
    expect(host.childElementCount).toBe(0);
  });
});
