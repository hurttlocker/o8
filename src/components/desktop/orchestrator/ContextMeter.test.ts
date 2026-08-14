// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { ContextMeter, projectContextMeter } from './ContextMeter';

afterEach(() => {
  document.body.replaceChildren();
});

describe('projectContextMeter', () => {
  it('keeps the runtime parent-context report authoritative', () => {
    expect(projectContextMeter(43_700, 4_000)).toEqual({
      source: 'runtime',
      activeTokens: 43_700,
      estimatedConversationTokens: 4_000,
      estimatedBaselineTokens: 11_600,
      unclassifiedRuntimeTokens: 28_100,
    });
  });

  it('labels the transcript plus prompt/tool baseline as an estimate before telemetry arrives', () => {
    expect(projectContextMeter(0, 4_000)).toEqual({
      source: 'estimate',
      activeTokens: 15_600,
      estimatedConversationTokens: 4_000,
      estimatedBaselineTokens: 11_600,
      unclassifiedRuntimeTokens: 0,
    });
  });

  it('states which values are runtime truth and which are estimates when opened', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(ContextMeter, { tokenCount: 1_200, runningTotal: 43_700 }));
    });
    const trigger = container.querySelector('button');
    expect(trigger?.getAttribute('aria-label')).toContain('Runtime-reported active context 43.7k / 1M');

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.body.textContent).toContain('Runtime reported');
    expect(document.body.textContent).toContain('System prompt estimate');
    expect(document.body.textContent).toContain('Visible transcript estimate');
    expect(document.body.textContent).toContain('Child-worker usage is excluded; category rows are estimates.');

    await act(async () => { root.unmount(); });
  });
});
