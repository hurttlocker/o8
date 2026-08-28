// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./PairedDevicesSection', () => ({ PairedDevicesSection: () => null }));

import { ConnectionsTab } from './ConnectionsTab';

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ConnectionsTab managed Symon Messages', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('collects the trusted sender before enabling the managed number', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/panel/connect/attach') {
        return Response.json({ ok: true, enabled: false, locked: false });
      }
      if (url === '/api/panel/symon/managed-messages' && init?.method === 'POST') {
        return Response.json({
          ok: true,
          enabled: true,
          phoneNumber: '+12545550111',
          allowedSenderHandle: '+12675550111',
          connected: true,
        });
      }
      if (url === '/api/panel/symon/managed-messages') {
        return Response.json({
          ok: true,
          enabled: false,
          phoneNumber: null,
          allowedSenderHandle: null,
          connected: true,
        });
      }
      return Response.json({ ok: false }, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(createElement(ConnectionsTab));
      await settle();
    });
    expect(container.textContent).toContain('CLI-backed replies');
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Phone number allowed to text Symon"]',
    );
    expect(input).not.toBeNull();
    await act(async () => {
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(input, '+1 (267) 555-0111');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await settle();
    });
    const switches = container.querySelectorAll<HTMLButtonElement>('[role="switch"]');
    expect(switches).toHaveLength(2);
    await act(async () => {
      switches[1]?.click();
      await settle();
    });
    const request = fetchMock.mock.calls.find((call) => (
      String(call[0]) === '/api/panel/symon/managed-messages'
      && call[1]?.method === 'POST'
    ));
    expect(request).toBeDefined();
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      enabled: true,
      allowedSenderHandle: '+1 (267) 555-0111',
    });
    expect(container.textContent).toContain('Text +12545550111');
    expect(container.textContent).toContain('tool approvals still happen inside o8');
  });
});
