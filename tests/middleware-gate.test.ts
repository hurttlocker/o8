/**
 * Deterministic suite for the API auth gate (src/middleware.ts).
 *
 * Covers the Tier-1 security model:
 *   - socket-truth header (x-o8-client-addr) is authoritative when present
 *   - dev-fallback heuristics only trust genuinely-loopback signals
 *   - bearer/ws-token fallback for LAN clients (mobile, Tailscale)
 *   - read-only allowlist + worker-route bypass behave as documented
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// The gate is what's under test — not Clerk's wrapper.
vi.mock('@clerk/nextjs/server', () => ({
  clerkMiddleware: (handler: unknown) => handler,
}));

const TEST_TOKEN = 'vitest-gate-token-0123456789abcdef';
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-gate-test-'));
writeFileSync(path.join(dataDir, 'ws-token'), `${TEST_TOKEN}\n`, 'utf-8');
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { panelGateMiddleware } = await import('@/middleware');

function gatedRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): NextRequest {
  return new NextRequest(url, {
    method: options.method ?? 'GET',
    headers: options.headers,
  });
}

describe('panelGateMiddleware — loopback trust', () => {
  it('passes curl-style loopback requests (Host only, no browser headers)', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://localhost:3001/api/panel/repos', {
        headers: { host: 'localhost:3001' },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('rejects LAN requests with no token', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/panel/repos', {
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('passes the Tauri webview origin', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://localhost:3001/api/orchestrator/threads', {
        headers: { host: 'localhost:3001', origin: 'tauri://localhost' },
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe('panelGateMiddleware — socket truth is authoritative', () => {
  it('rejects a known-LAN socket even when every other header is spoofed loopback', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://localhost:3001/api/panel/repos', {
        headers: {
          'x-o8-client-addr': '192.168.1.50',
          host: 'localhost:3001',
          origin: 'http://localhost:3001',
          'sec-fetch-site': 'same-origin',
        },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('passes a known-loopback socket regardless of Host', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/panel/repos', {
        headers: {
          'x-o8-client-addr': '::ffff:127.0.0.1',
          host: '192.168.1.50:3001',
        },
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe('panelGateMiddleware — bearer token fallback for LAN clients', () => {
  it('passes with the correct ws-token as a Bearer header', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/mobile/inbox', {
        headers: {
          host: '192.168.1.50:3001',
          authorization: `Bearer ${TEST_TOKEN}`,
        },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('passes with the correct token as a query parameter (WS upgrade path)', () => {
    const res = panelGateMiddleware(
      gatedRequest(`http://192.168.1.50:3001/api/mobile/inbox?token=${TEST_TOKEN}`, {
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('rejects a wrong token', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/mobile/inbox', {
        headers: {
          host: '192.168.1.50:3001',
          authorization: 'Bearer wrong-token-with-the-same-length00',
        },
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe('panelGateMiddleware — allowlists and bypasses', () => {
  it('allows read-only setup GETs from anywhere', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/setup/status', {
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('still gates setup WRITES from LAN (config-write CSRF protection)', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/setup/claude-desktop', {
        method: 'POST',
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('allows the mobile push public key (needed before any pairing)', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/mobile/push/public-key', {
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('bypasses worker-protocol routes (they run their own bearer auth)', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/worker/poll', {
        method: 'POST',
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('passes ungated API families untouched', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/github/webhook', {
        method: 'POST',
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(200);
  });
});
