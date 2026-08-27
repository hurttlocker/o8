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

  it('shows a persisted flag age and the scheduled warning threshold', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      shippedDarkAudit: {
        schema: 'o8/shipped-dark-audit-status/v1',
        status: 'attention',
        checkedAt: '2026-08-27T12:05:00.000Z',
        currentRelease: '0.1.716',
        thresholdReleases: 3,
        checkedFlagCount: 14,
        flags: [{
          tomlKey: 'experimental.chat_enabled',
          codeDefault: false,
          operatorValue: false,
          operatorValueSource: 'default',
          landedRelease: '0.1.681',
          darkForReleases: 35,
        }],
      },
    })));

    await act(async () => {
      root.render(createElement(ShippedDarkAuditSection));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain('Shipped feature audit');
    expect(container.textContent).toContain('1 need attention');
    expect(container.textContent).toContain('experimental.chat_enabled');
    expect(container.textContent).toContain('35 releases');
    expect(container.textContent).toContain('every 24 hours');
  });
});
