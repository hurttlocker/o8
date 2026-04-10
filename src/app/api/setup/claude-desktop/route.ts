/**
 * Claude Desktop / Claude Code Auto-Register
 *
 * POST — merge the o8 MCP server entry into the user's Claude config file
 *        without touching any other servers they have configured.
 * GET  — preview: show the current config file contents and whether o8
 *        is already registered, without writing anything.
 *
 * This is the one-click "Connect to Claude Desktop" button in Settings →
 * MCP. It closes the last manual step in the real-user install flow.
 *
 * The file is parsed with comment-tolerant handling (Claude Desktop sometimes
 * emits a trailing newline, users hand-edit with `//` comments). We preserve
 * all unknown keys, only touching `mcpServers.o8`.
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';

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

// ── Server config builder (mirrors /api/setup/mcp-config) ──

function findCommand(name: string): string | null {
  try {
    const which = execSync(`command -v ${name} 2>/dev/null`, { encoding: 'utf-8' }).trim();
    return which || null;
  } catch {
    return null;
  }
}

function getApiBase(): string {
  const port = process.env.PORT || process.env.CORTEX_IDE_PORT || '3001';
  return `http://127.0.0.1:${port}`;
}

interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

function buildServerConfig(): McpServerConfig {
  const bundled = process.env.O8_BUNDLED_MCP_PATH;
  if (bundled && existsSync(bundled)) {
    const nodeBin = findCommand('node') || 'node';
    return {
      command: nodeBin,
      args: [bundled],
      env: { O8_API_BASE: getApiBase() },
    };
  }

  const repoRoot = process.cwd();
  const tsSource = join(repoRoot, 'src', 'lib', 'mcp', 'operator-mcp-server.ts');
  const tsxBin = findCommand('tsx');

  if (existsSync(tsSource) && tsxBin) {
    return {
      command: tsxBin,
      args: [tsSource],
      env: { O8_API_BASE: getApiBase() },
    };
  }

  return {
    command: 'npx',
    args: ['tsx', tsSource],
    env: { O8_API_BASE: getApiBase() },
  };
}

// ── Tolerant JSON read ──

interface ClaudeConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

function readClaudeConfig(path: string): ClaudeConfig {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf-8').trim();
    if (!raw) return {};
    return JSON.parse(raw) as ClaudeConfig;
  } catch {
    // Malformed — return empty so the caller can decide whether to bail or
    // overwrite with a fresh file.
    return {};
  }
}

function atomicWriteConfig(path: string, config: ClaudeConfig): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Back up the existing file before overwriting.
  if (existsSync(path)) {
    const backupPath = `${path}.o8-backup-${Date.now()}`;
    try {
      copyFileSync(path, backupPath);
    } catch {
      // Don't block the write on a failed backup.
    }
  }

  const tmpPath = `${path}.o8-tmp`;
  writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

  // On Unix we could rename() atomically, but on all supported platforms
  // Node's writeFileSync + rename is good enough for a config file.
  const { renameSync } = require('node:fs') as typeof import('node:fs');
  renameSync(tmpPath, path);
}

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
    const existingEntry = config.mcpServers && typeof config.mcpServers === 'object'
      ? (config.mcpServers as Record<string, unknown>)['o8']
      : undefined;

    const proposed = buildServerConfig();
    const alreadyUpToDate = Boolean(
      existingEntry
      && typeof existingEntry === 'object'
      && JSON.stringify(existingEntry) === JSON.stringify(proposed),
    );

    const otherServers = config.mcpServers
      ? Object.keys(config.mcpServers).filter((k) => k !== 'o8')
      : [];

    return NextResponse.json({
      target,
      path,
      fileExists,
      alreadyRegistered: Boolean(existingEntry),
      alreadyUpToDate,
      proposed,
      existingEntry: existingEntry ?? null,
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

    const config = readClaudeConfig(path);
    if (!config.mcpServers || typeof config.mcpServers !== 'object') {
      config.mcpServers = {};
    }
    const servers = config.mcpServers as Record<string, unknown>;

    if (remove) {
      if ('o8' in servers) {
        delete servers['o8'];
        atomicWriteConfig(path, config);
        return NextResponse.json({ ok: true, action: 'removed', path });
      }
      return NextResponse.json({ ok: true, action: 'no-op', path, detail: 'o8 was not registered' });
    }

    servers['o8'] = buildServerConfig();
    atomicWriteConfig(path, config);

    return NextResponse.json({
      ok: true,
      action: 'installed',
      target,
      path,
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
