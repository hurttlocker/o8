import { NextResponse } from 'next/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/panel/status
 *
 * Reads OpenClaw config directly (same as gateway-client.ts) and probes
 * the gateway with the auth token. No CLI dependency — fast and reliable.
 */

interface OpenClawConfig {
  gateway?: {
    port?: number;
    mode?: string;
    bind?: string;
    auth?: { token?: string };
    tailscale?: { mode?: string };
  };
  agents?: {
    list?: Array<{ id: string; name?: string }>;
  };
}

function readOpenClawConfig(): OpenClawConfig | null {
  try {
    const raw = readFileSync(join(homedir(), '.openclaw', 'openclaw.json'), 'utf-8');
    return JSON.parse(raw) as OpenClawConfig;
  } catch {
    return null;
  }
}

function deriveMode(config: OpenClawConfig | null): string {
  if (config?.gateway?.tailscale?.mode === 'on') return 'tailscale';
  return config?.gateway?.mode || 'local';
}

export async function GET() {
  const config = readOpenClawConfig();
  const port = config?.gateway?.port ?? 18789;
  const token = config?.gateway?.auth?.token ?? '';
  const gatewayUrl = `127.0.0.1:${port}`;
  const agentCount = config?.agents?.list?.length ?? 0;

  let connected = false;
  let version = 'unknown';
  let ocPlatform = '';
  let ocNode = '';

  // Probe the gateway — just fetch the root page (always 200 if alive)
  // and try the REST API with auth for richer data
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);

    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      connected = true;
    }
  } catch {
    connected = false;
  }

  // If reachable, try to get version info from the REST API
  if (connected && token) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);

      const res = await fetch(`http://127.0.0.1:${port}/api/v1/status?activeMinutes=1`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json() as {
          gateway?: { self?: { version?: string; platform?: string }; node?: string };
        };
        version = data?.gateway?.self?.version || version;
        ocPlatform = data?.gateway?.self?.platform || '';
      }
    } catch {
      // REST API might not exist on this version — that's OK, we already confirmed connected
    }
  }

  // If REST didn't give us version, try reading from the OpenClaw install
  if (version === 'unknown') {
    try {
      const pkgRaw = readFileSync(join(homedir(), 'openclaw', 'package.json'), 'utf-8');
      const pkg = JSON.parse(pkgRaw) as { version?: string };
      if (pkg.version) version = pkg.version;
    } catch { /* ignore */ }
  }

  return NextResponse.json({
    connected,
    gatewayUrl,
    version,
    agentCount,
    platform: ocPlatform || process.platform,
    nodeVersion: ocNode || process.version.replace(/^v/, ''),
    mode: deriveMode(config),
    uptime: connected ? 'active' : null,
  });
}
