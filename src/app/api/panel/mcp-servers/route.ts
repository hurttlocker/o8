export const dynamic = 'force-dynamic';

/**
 * Panel-gated external MCP server registry.
 *
 * GET  /api/panel/mcp-servers          — list all registered servers
 * POST /api/panel/mcp-servers          — register a new server
 *
 * These routes are behind the panel middleware gate (loopback + ws-token).
 * The orchestrator session spawn path reads from the same `external_mcp_servers`
 * table via `listEnabledExternalMcpServers()` in src/lib/mcp/external-servers.ts.
 *
 * Closes #519 — external MCP servers as context sources for orchestrator dispatch.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import {
  insertExternalMcpServer,
  listExternalMcpServers,
  type ExternalMcpTransport,
} from '@/lib/mcp/external-servers';

function isTransport(value: unknown): value is ExternalMcpTransport {
  return value === 'stdio' || value === 'http';
}

function parseArgs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry : ''))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseEnv(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const next: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') continue;
    const trimmedKey = key.trim();
    if (!trimmedKey) continue;
    next[trimmedKey] = raw;
  }
  return Object.keys(next).length > 0 ? next : null;
}

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  try {
    return NextResponse.json({ servers: listExternalMcpServers() });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to load MCP servers', detail: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  try {
    const body = await request.json().catch(() => ({})) as {
      teamId?: unknown;
      name?: unknown;
      transport?: unknown;
      command?: unknown;
      args?: unknown;
      env?: unknown;
      url?: unknown;
      oauthToken?: unknown;
      enabled?: unknown;
    };

    if (typeof body.name !== 'string' || !body.name.trim()) {
      return NextResponse.json({ error: 'Server name is required' }, { status: 400 });
    }
    if (!isTransport(body.transport)) {
      return NextResponse.json({ error: 'Transport must be "stdio" or "http"' }, { status: 400 });
    }
    if (typeof body.command !== 'string' || !body.command.trim()) {
      return NextResponse.json(
        { error: body.transport === 'http' ? 'Server URL is required' : 'Command is required' },
        { status: 400 },
      );
    }

    const teamId = typeof body.teamId === 'string' && body.teamId.trim()
      ? body.teamId.trim()
      : null;
    const url = body.transport === 'http' && typeof body.url === 'string' && body.url.trim()
      ? body.url.trim()
      : null;
    const oauthToken = typeof body.oauthToken === 'string' && body.oauthToken.trim()
      ? body.oauthToken.trim()
      : null;

    const server = insertExternalMcpServer({
      teamId,
      name: body.name,
      transport: body.transport,
      command: body.command,
      args: parseArgs(body.args),
      env: parseEnv(body.env),
      url,
      oauthToken,
      enabled: body.enabled !== false,
    });

    return NextResponse.json({ ok: true, server }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create MCP server' },
      { status: 400 },
    );
  }
}
