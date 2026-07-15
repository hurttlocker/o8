import type { BrowserContext, Route, WebSocketRoute } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { BROWSER_NETWORK_CONTEXT_OPTIONS, installBrowserNetworkPolicy } from './network-policy';

type HttpHandler = (route: Route) => Promise<unknown> | unknown;
type WebSocketHandler = (route: WebSocketRoute) => Promise<unknown> | unknown;

function policyHarness() {
  let httpHandler: HttpHandler | undefined;
  let webSocketHandler: WebSocketHandler | undefined;
  const route = vi.fn(async (_pattern: string, handler: HttpHandler) => {
    httpHandler = handler;
  });
  const routeWebSocket = vi.fn(async (_pattern: string, handler: WebSocketHandler) => {
    webSocketHandler = handler;
  });
  const context = { route, routeWebSocket } as unknown as Pick<BrowserContext, 'route' | 'routeWebSocket'>;
  return {
    context,
    route,
    routeWebSocket,
    httpHandler: () => httpHandler,
    webSocketHandler: () => webSocketHandler,
  };
}

describe('browser engine network policy', () => {
  it('blocks service workers and installs HTTP plus WebSocket routing before page creation', async () => {
    const harness = policyHarness();
    await installBrowserNetworkPolicy(harness.context);

    expect(BROWSER_NETWORK_CONTEXT_OPTIONS.serviceWorkers).toBe('block');
    expect(harness.route).toHaveBeenCalledWith('**/*', expect.any(Function));
    expect(harness.routeWebSocket).toHaveBeenCalledWith('**/*', expect.any(Function));
  });

  it('closes a loopback WebSocket without opening a server connection', async () => {
    const harness = policyHarness();
    await installBrowserNetworkPolicy(harness.context);
    const close = vi.fn(async () => undefined);
    const connectToServer = vi.fn();

    await harness.webSocketHandler()?.({
      url: () => 'ws://127.0.0.1:47125/private',
      close,
      connectToServer,
    } as unknown as WebSocketRoute);

    expect(connectToServer).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith({ code: 1008, reason: 'Blocked by o8 network policy' });
  });

  it('connects a public-address WebSocket after validation', async () => {
    const harness = policyHarness();
    await installBrowserNetworkPolicy(harness.context);
    const close = vi.fn(async () => undefined);
    const connectToServer = vi.fn();

    await harness.webSocketHandler()?.({
      url: () => 'wss://1.1.1.1/socket',
      close,
      connectToServer,
    } as unknown as WebSocketRoute);

    expect(connectToServer).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });
});
