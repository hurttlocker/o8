// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ShippedDarkAuditSection } from './ShippedDarkAuditSection';

describe('ShippedDarkAuditSection', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function stubStatus(payload: unknown): void {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ shippedDarkAudit: payload })));
  }

  async function render(): Promise<void> {
    await act(async () => {
      root.render(createElement(ShippedDarkAuditSection));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it('shows a persisted flag age and the scheduled warning threshold', async () => {
    stubStatus({
      schema: 'o8/shipped-dark-audit-status/v2',
      status: 'attention',
      checkedAt: '2026-08-27T12:05:00.000Z',
      currentRelease: '0.1.716',
      thresholdReleases: 3,
      checkedFlagCount: 14,
      attentionFlagCount: 1,
      flags: [{
        tomlKey: 'experimental.canvas_enabled',
        codeDefault: false,
        operatorValue: false,
        operatorValueSource: 'default',
        landedRelease: '0.1.681',
        darkForReleases: 35,
        lifecycle: 'promotion-candidate',
        lifecycleRationale: null,
        needsAttention: true,
      }],
    });

    await render();

    expect(container.textContent).toContain('Shipped feature audit');
    expect(container.textContent).toContain('1 need attention');
    expect(container.textContent).toContain('experimental.canvas_enabled');
    expect(container.textContent).toContain('35 releases');
    expect(container.textContent).toContain('Awaiting promotion review');
    expect(container.textContent).toContain('every 24 hours');
  });

  it('lists a deliberate default-off flag with its rationale and no warning', async () => {
    stubStatus({
      schema: 'o8/shipped-dark-audit-status/v2',
      status: 'current',
      checkedAt: '2026-08-27T12:05:00.000Z',
      currentRelease: '0.1.716',
      thresholdReleases: 3,
      checkedFlagCount: 14,
      attentionFlagCount: 0,
      flags: [{
        tomlKey: 'review.quiz_gate_enabled',
        codeDefault: false,
        operatorValue: false,
        operatorValueSource: 'default',
        landedRelease: '0.1.681',
        darkForReleases: 35,
        lifecycle: 'deliberate-default-off',
        lifecycleRationale: 'Optional human quiz speed bump before the merge button.',
        needsAttention: false,
      }],
    });

    await render();

    expect(container.textContent).toContain('review.quiz_gate_enabled');
    expect(container.textContent).toContain('landed 0.1.681');
    expect(container.textContent).toContain('35 releases');
    expect(container.textContent).toContain('Off by design');
    expect(container.textContent).toContain('Optional human quiz speed bump before the merge button.');
    expect(container.textContent).toContain('Current');
    expect(container.textContent).not.toContain('need attention');
  });

  it('counts only declared deliberate flags as by design', async () => {
    stubStatus({
      schema: 'o8/shipped-dark-audit-status/v2',
      status: 'current',
      checkedAt: '2026-08-27T12:05:00.000Z',
      currentRelease: '0.1.716',
      thresholdReleases: 3,
      checkedFlagCount: 14,
      attentionFlagCount: 0,
      flags: [{
        tomlKey: 'review.quiz_gate_enabled',
        codeDefault: false,
        operatorValue: false,
        operatorValueSource: 'profile',
        landedRelease: '0.1.681',
        darkForReleases: 35,
        lifecycle: 'deliberate-default-off',
        lifecycleRationale: 'Optional human quiz speed bump before the merge button.',
        needsAttention: false,
      }, {
        tomlKey: 'experimental.canvas_enabled',
        codeDefault: false,
        operatorValue: false,
        operatorValueSource: 'default',
        landedRelease: '0.1.715',
        darkForReleases: 1,
        lifecycle: 'promotion-candidate',
        lifecycleRationale: null,
        needsAttention: false,
      }],
    });

    await render();

    // A young promotion candidate is not overdue, but it is not by design either.
    expect(container.textContent).toContain('2 remain dark (1 by design)');
    expect(container.textContent).toContain('Off by design');
    expect(container.textContent).toContain('Awaiting promotion review');
    expect(container.textContent).not.toContain('need attention');
  });
});
