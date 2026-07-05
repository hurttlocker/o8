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

  it('gates /api/v2/files (repo file WRITE surface) against LAN', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/v2/files', {
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('gates /api/v2/context/files (chat context git-exec sink) against cross-origin', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/v2/context/files?q=x', {
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('gates /api/panel/file-io (arbitrary-path canvas file card) against LAN', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/panel/file-io?path=/etc/hosts', {
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('gates /api/panel/app/relaunch (desktop restart request) against LAN', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/panel/app/relaunch', {
        method: 'POST',
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('gates /api/browser/agent (embedded-browser verb bridge) against LAN', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/browser/agent', {
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('gates /api/browser/engine/view (headless-Chrome live view) against LAN', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/browser/engine/view?scope=operator', {
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('gates /api/canvas/intent (canvas intent bus) against LAN', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/canvas/intent', {
        method: 'POST',
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('gates /api/orchestrator/steer-packet (extracted layer-3 steer mutation) against LAN', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/orchestrator/steer-packet', {
        method: 'POST',
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('gates /api/voice/realtime/session (mints OpenAI realtime tokens on the operator key) against LAN', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/voice/realtime/session', {
        method: 'POST',
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('gates /api/invites (beta founding-invite codes) against LAN', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/invites', {
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('passes /api/browser/proxy from loopback (the in-webview iframe is loopback)', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://localhost:3001/api/browser/proxy?url=http%3A%2F%2Flocalhost%3A3005', {
        headers: { host: 'localhost:3001' },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('now GATES /api/browser/proxy against LAN (RF-4: was the SSRF entry point)', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/browser/proxy?url=http%3A%2F%2Flocalhost%3A3001', {
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

  it('allows /api/mobile/enroll POST from LAN (#5 bootstrap — handler auths the enroll code)', () => {
    // An unpaired phone has no bearer token yet; enrollment bypasses the gate and
    // the route handler requires a valid single-use enroll code instead.
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/mobile/enroll', {
        method: 'POST',
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('still gates the rest of /api/mobile/* from LAN without a token (#5 — only enroll is open)', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/mobile/devices', {
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
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

  it('bypasses the HMAC-verified GitHub webhook (external caller, self-auth)', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/github/webhook', {
        method: 'POST',
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe('panelGateMiddleware — default-deny (RF-2: no fail-open)', () => {
  it('denies a previously-ungated state route from LAN (/api/board)', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/board?repo=x', {
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('denies an UNLISTED /api route from LAN (proves the default is deny, not pass)', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://192.168.1.50:3001/api/some-future-route-nobody-gated', {
        method: 'POST',
        headers: { host: '192.168.1.50:3001' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('still passes that unlisted route from loopback (operator surface unaffected)', () => {
    const res = panelGateMiddleware(
      gatedRequest('http://localhost:3001/api/some-future-route-nobody-gated', {
        method: 'POST',
        headers: { host: 'localhost:3001' },
      }),
    );
    expect(res.status).toBe(200);
  });
});
