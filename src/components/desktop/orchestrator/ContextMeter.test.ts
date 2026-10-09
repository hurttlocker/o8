// @vitest-environment jsdom

import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContextMeter, projectContextMeter } from './ContextMeter';
import { OrchestratorContextResidencyProvider, useOrchestratorContextResidency } from './context-residency';

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
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

  it('shows reported prompt reuse in the inner ring and the context popover', async () => {
    function ReportedTranscript() {
      const publish = useOrchestratorContextResidency()!.publish;
      useEffect(() => publish({ messages: [{ id: 'a', role: 'assistant', text: 'Done', tokens: { input: 200, output: 20, cacheRead: 800 } }], runningTotal: 40_000, activeAssistantId: null }), [publish]);
      return createElement(ContextMeter, { tokenCount: 1_000, runningTotal: 40_000 });
    }
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(OrchestratorContextResidencyProvider, null, createElement(ReportedTranscript))));
    expect(container.querySelector('[data-testid="context-cache-ring"]')).not.toBeNull();
    expect(container.querySelector('button')!.getAttribute('aria-label')).toContain('reused 80%');
    await act(async () => container.querySelector('button')!.click());
    expect(document.querySelector('[data-testid="context-cache-reuse"]')!.textContent).toBe('80% reused');
    expect(document.body.textContent).toContain('Expiry is not reported');
    await act(async () => root.unmount());
  });
});
