// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalStatusEvidence } from '@/lib/terminal-status/resolve';
import { TerminalStatusEvidenceDisclosure } from './TerminalStatusEvidenceRows';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

const fixture: TerminalStatusEvidence = {
  sessionId: 'codex-owned:evidence-rows',
  runtime: 'codex',
  state: 'blocked',
  authority: 'lane-state',
  observedAt: '2026-08-29T12:00:00.000Z',
  summary: 'Approval pending: continue the governed run.',
  evidence: [
    { source: 'lane:lane-evidence.status', value: 'awaiting_human' },
    { source: 'approval:approval-evidence', value: 'pending · Continue the run.' },
  ],
  fallbackReason: 'No runtime event evidence was available, so lane state is the next available authority.',
};

describe('TerminalStatusEvidenceDisclosure', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-29T12:03:00.000Z');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('renders the state and selected authority caption with evidence rows', async () => {
    await act(async () => {
      root.render(createElement(TerminalStatusEvidenceDisclosure, {
        evidence: fixture,
        defaultExpanded: true,
      }));
    });

    expect(container.textContent).toContain('blocked · lane');
    expect(container.textContent).toContain('Lane status');
    expect(container.textContent).toContain('awaiting_human');
    expect(container.textContent).toContain('3 min ago');
  });

  it('renders relative observation time with the ISO value available on hover', async () => {
    vi.setSystemTime('2026-08-29T12:00:41.000Z');
    await act(async () => {
      root.render(createElement(TerminalStatusEvidenceDisclosure, {
        evidence: fixture,
        defaultExpanded: true,
      }));
    });

    const observed = container.querySelector('[data-terminal-status-evidence-row="observed"]');
    expect(observed?.textContent).toContain('41 s ago');
    expect(observed?.querySelectorAll('[title]')[1]?.getAttribute('title')).toBe(fixture.observedAt);
  });

  it('maps known evidence sources to readable labels', async () => {
    await act(async () => {
      root.render(createElement(TerminalStatusEvidenceDisclosure, {
        evidence: {
          ...fixture,
          evidence: [
            { source: 'runtime-session.status', value: 'running' },
            { source: 'owned-run:run-1', value: 'finished' },
            { source: 'lane:lane-1.status', value: 'reviewing' },
            { source: 'lane-event:review_ready', value: 'ready' },
            { source: 'approval:approval-1', value: 'pending' },
            { source: 'review_queue:review-1', value: 'pending review' },
            { source: 'raw-terminal.lifecycle', value: 'active' },
            { source: 'custom.signal', value: 'custom' },
          ],
        },
        defaultExpanded: true,
      }));
    });

    for (const label of [
      'Runtime status',
      'Run',
      'Lane status',
      'Lane event · review ready',
      'Approval',
      'Review queue',
      'Terminal',
      'custom.signal',
    ]) {
      expect(container.textContent).toContain(label);
    }
  });

  it('collapses consecutive equal values from one authority and keeps every source on hover', async () => {
    await act(async () => {
      root.render(createElement(TerminalStatusEvidenceDisclosure, {
        evidence: {
          ...fixture,
          authority: 'runtime-event',
          evidence: [
            { source: 'runtime-session.status', value: 'running' },
            { source: 'runtime-session.lifecycle', value: 'running' },
            { source: 'raw-terminal.lifecycle', value: 'running' },
          ],
        },
        defaultExpanded: true,
      }));
    });

    const runtimeRow = container.querySelector('[data-terminal-status-evidence-row="Runtime status"]');
    expect(runtimeRow?.querySelector('span')?.getAttribute('title')).toBe(
      'runtime-session.status\nruntime-session.lifecycle',
    );
    expect(container.querySelector('[data-terminal-status-evidence-row="Runtime lifecycle"]')).toBeNull();
    expect(container.querySelector('[data-terminal-status-evidence-row="Terminal"]')).not.toBeNull();
    expect(runtimeRow?.querySelectorAll('span')[1]?.style.lineHeight).toBe('1.25');
  });

  it('shows fallback reason only when the record carries one', async () => {
    await act(async () => {
      root.render(createElement(TerminalStatusEvidenceDisclosure, {
        evidence: fixture,
        defaultExpanded: true,
      }));
    });
    expect(container.textContent).toContain(fixture.fallbackReason);

    await act(async () => {
      root.render(createElement(TerminalStatusEvidenceDisclosure, {
        evidence: { ...fixture, fallbackReason: undefined },
        defaultExpanded: true,
      }));
    });
    expect(container.textContent).not.toContain('No runtime event evidence was available');
    expect(container.querySelector('[data-terminal-status-evidence-row="fallback"]')).toBeNull();
  });

  function disclosureFor(sessionId: string): HTMLElement {
    const disclosure = container.querySelector<HTMLElement>(
      `[data-terminal-status-evidence="${sessionId}"]`,
    );
    if (!disclosure) throw new Error(`No disclosure rendered for ${sessionId}`);
    return disclosure;
  }

  it('gives two sessions distinct evidence region ids with matching aria-controls once opened', async () => {
    const otherFixture: TerminalStatusEvidence = {
      ...fixture,
      sessionId: 'claude-owned:other-rows',
    };
    await act(async () => {
      root.render(createElement(
        'div',
        null,
        createElement(TerminalStatusEvidenceDisclosure, { evidence: fixture }),
        createElement(TerminalStatusEvidenceDisclosure, { evidence: otherFixture }),
      ));
    });

    const buttons = [fixture, otherFixture].map(
      ({ sessionId }) => disclosureFor(sessionId).querySelector('button')!,
    );
    for (const button of buttons) {
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(button.hasAttribute('aria-controls')).toBe(false);
    }

    await act(async () => {
      for (const button of buttons) button.click();
    });

    const ids = buttons.map((button) => button.getAttribute('aria-controls'));
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);

    for (const [index, { sessionId }] of [fixture, otherFixture].entries()) {
      expect(buttons[index].getAttribute('aria-expanded')).toBe('true');
      const region = document.getElementById(ids[index]!);
      expect(region).not.toBeNull();
      expect(region?.getAttribute('role')).toBe('group');
      expect(disclosureFor(sessionId).contains(region)).toBe(true);
    }
  });

  it('keeps region ids unique when the same session is disclosed twice', async () => {
    await act(async () => {
      root.render(createElement(
        'div',
        null,
        createElement(TerminalStatusEvidenceDisclosure, { evidence: fixture, defaultExpanded: true }),
        createElement(TerminalStatusEvidenceDisclosure, { evidence: fixture, defaultExpanded: true }),
      ));
    });

    const buttons = [...container.querySelectorAll('button')];
    const ids = buttons.map((button) => button.getAttribute('aria-controls'));
    expect(buttons).toHaveLength(2);
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);
    for (const [index, button] of buttons.entries()) {
      expect(button.parentElement?.contains(document.getElementById(ids[index]!))).toBe(true);
    }
  });

  it('drops aria-controls and the region together when the evidence is collapsed', async () => {
    await act(async () => {
      root.render(createElement(TerminalStatusEvidenceDisclosure, {
        evidence: fixture,
        defaultExpanded: true,
      }));
    });

    const button = container.querySelector('button')!;
    const regionId = button.getAttribute('aria-controls');
    expect(regionId).toBeTruthy();
    expect(document.getElementById(regionId!)).not.toBeNull();

    await act(async () => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.hasAttribute('aria-controls')).toBe(false);
    expect(document.getElementById(regionId!)).toBeNull();
  });
});
