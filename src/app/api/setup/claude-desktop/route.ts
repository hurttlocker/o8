/**
 * Claude Desktop / Claude Code Auto-Register
 *
 * POST — merge the o8 + codebase-memory MCP server entries into the user's
 *        Claude config file without touching any other servers they have
 *        configured. codebase-memory is registered only when its binary
 *        resolves (env var or `~/.o8/bin/codebase-memory-mcp{.exe}`); cold
 *        first launch (binary not yet downloaded) skips it gracefully so
 *        Claude Code session boot stays clean.
 * GET  — preview: show the current config file contents and whether the
 *        servers are already registered, without writing anything.
 *
 * This is the one-click "Connect to Claude Desktop" button in Settings →
 * MCP. It closes the last manual step in the real-user install flow.
 *
 * The file is parsed with comment-tolerant handling (Claude Desktop sometimes
 * emits a trailing newline, users hand-edit with `//` comments). We preserve
 * all unknown keys, only touching `mcpServers.o8` and `mcpServers.codebase-memory`.
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readClaudeConfig, atomicWriteConfig } from '@/lib/mcp/claude-desktop-config-io';
import { getMcpSetupReadiness } from '@/lib/mcp/setup-readiness';
import { buildToolRegistry } from '@/lib/mcp/tool-spine/build';
import { entriesForSurface } from '@/lib/mcp/tool-spine/registry';
import { toClaudeDesktopJson } from '@/lib/mcp/tool-spine/emit-claude-desktop';

// ── Config path resolution ──

type Target = 'claude-desktop' | 'claude-code';

function getTargetConfigPath(target: Target): string {
  const home = process.env.HOME || '';

  if (target === 'claude-desktop') {
    if (process.platform === 'darwin') {
      return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    }
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
      return join(appData, 'Claude', 'claude_desktop_config.json');
    }
    return join(home, '.config', 'Claude', 'claude_desktop_config.json');
  }

  // claude-code: the global user config lives at ~/.claude.json on all platforms.
  return join(home, '.claude.json');
}

// ── Server config: the Tool-Spine claude-desktop projection ──
//
// The operator ("o8") + codebase-memory entries (type stripped for stdio) come
// from one registry projection — `toClaudeDesktopJson` for the merge write,
// `entriesForSurface(..., 'claude-desktop')` for the install list. repoPath is
// irrelevant to this surface (cortex/externals are filtered out), so any path
// works; process.cwd() keeps the resolver inputs identical to the old builder.

// ── Routes ──

function normalizeTarget(value: unknown): Target {
  if (value === 'claude-code') return 'claude-code';
  return 'claude-desktop';
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const target = normalizeTarget(url.searchParams.get('target'));
    const path = getTargetConfigPath(target);

    const fileExists = existsSync(path);
    const config = readClaudeConfig(path);
    const existingServers = config.mcpServers && typeof config.mcpServers === 'object'
      ? (config.mcpServers as Record<string, unknown>)
      : {};
    const existingEntry = existingServers['o8'];
    const existingCodebaseMemoryEntry = existingServers['codebase-memory'];

    const mcpReady = getMcpSetupReadiness();
    const projected = mcpReady.ready
      ? toClaudeDesktopJson(buildToolRegistry(process.cwd()), {}).mcpServers as Record<string, unknown>
      : {};
    const proposed = projected['o8'];
    const proposedCodebaseMemory = projected['codebase-memory'] ?? null;

    const alreadyUpToDate = Boolean(
      existingEntry
      && typeof existingEntry === 'object'
      && JSON.stringify(existingEntry) === JSON.stringify(proposed),
    );
    const codebaseMemoryUpToDate = proposedCodebaseMemory
      ? Boolean(
        existingCodebaseMemoryEntry
        && typeof existingCodebaseMemoryEntry === 'object'
        && JSON.stringify(existingCodebaseMemoryEntry) === JSON.stringify(proposedCodebaseMemory),
      )
      : null;

    const otherServers = config.mcpServers
      ? Object.keys(config.mcpServers).filter((k) => k !== 'o8' && k !== 'codebase-memory')
      : [];

    return NextResponse.json({
      target,
      path,
      fileExists,
      alreadyRegistered: Boolean(existingEntry),
      alreadyUpToDate: mcpReady.ready ? alreadyUpToDate : false,
      setupReady: mcpReady.ready,
      setupBlockedReason: mcpReady.reason,
      setupBlockedDetail: mcpReady.detail,
      proposed,
      existingEntry: existingEntry ?? null,
      proposedCodebaseMemory,
      existingCodebaseMemoryEntry: existingCodebaseMemoryEntry ?? null,
      codebaseMemoryAvailable: Boolean(proposedCodebaseMemory),
      codebaseMemoryRegistered: Boolean(existingCodebaseMemoryEntry),
      codebaseMemoryUpToDate,
      otherServers,
      size: fileExists ? statSync(path).size : 0,
    });
  } catch (error) {
    console.error('[setup/claude-desktop] GET error:', error);
    return NextResponse.json(
      { error: 'Failed to inspect Claude config', detail: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as { target?: unknown; remove?: unknown };
    const target = normalizeTarget(body.target);
    const remove = body.remove === true;
    const path = getTargetConfigPath(target);
    const mcpReady = getMcpSetupReadiness();
    if (!remove && !mcpReady.ready) {
      return NextResponse.json(
        {
          ok: false,
          error: 'MCP setup is not ready',
          detail: mcpReady.detail,
          setupBlockedReason: mcpReady.reason,
        },
        { status: 409 },
      );
    }

    const config = readClaudeConfig(path);
    if (!config.mcpServers || typeof config.mcpServers !== 'object') {
      config.mcpServers = {};
    }
    const servers = config.mcpServers as Record<string, unknown>;

    if (remove) {
      const removed: string[] = [];
      if ('o8' in servers) {
        delete servers['o8'];
        removed.push('o8');
      }
      if ('codebase-memory' in servers) {
        delete servers['codebase-memory'];
        removed.push('codebase-memory');
      }
      if (removed.length > 0) {
        atomicWriteConfig(path, config);
        return NextResponse.json({ ok: true, action: 'removed', path, removed });
      }
      return NextResponse.json({ ok: true, action: 'no-op', path, detail: 'o8 was not registered' });
    }

    // Merge via the Tool-Spine claude-desktop projection: spreads every existing
    // server + top-level key, overwrites only o8 + codebase-memory, strips the
    // stdio `type`. codebase-memory is opt-in — the registry omits it when its
    // binary is absent (cold first launch), so it's simply not in `installed`.
    const registry = buildToolRegistry(process.cwd());
    const installed = entriesForSurface(registry, 'claude-desktop').map((entry) => entry.name);
    const merged = toClaudeDesktopJson(registry, config);
    atomicWriteConfig(path, merged);

    return NextResponse.json({
      ok: true,
      action: 'installed',
      target,
      path,
      installed,
      codebaseMemoryAvailable: installed.includes('codebase-memory'),
      detail:
        target === 'claude-desktop'
          ? 'Restart Claude Desktop to load the o8 tools.'
          : 'Restart Claude Code (or run /mcp reload) to load the o8 tools.',
    });
  } catch (error) {
    console.error('[setup/claude-desktop] POST error:', error);
    return NextResponse.json(
      {
        ok: false,
        error: 'Failed to write Claude config',
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
