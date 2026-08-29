// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('renders the state and selected authority caption with evidence rows', async () => {
    await act(async () => {
      root.render(createElement(TerminalStatusEvidenceDisclosure, {
        evidence: fixture,
        defaultExpanded: true,
      }));
    });

    expect(container.textContent).toContain('blocked · lane');
    expect(container.textContent).toContain('lane:lane-evidence.status');
    expect(container.textContent).toContain('awaiting_human');
    expect(container.textContent).toContain('2026-08-29T12:00:00.000Z');
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
});
