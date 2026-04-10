/**
 * MCP Config Generator
 *
 * Emits the Claude Desktop / Claude Code MCP server config for the current
 * o8 install. Lets a real user install the packaged Tauri app, hit this
 * endpoint, and get a copy-paste-ready config without hardcoded dev paths.
 *
 * Two install modes:
 *   1. Dev checkout — use `tsx` against the source file in-tree.
 *   2. Packaged Tauri app — use `node` against the bundled .mjs in the
 *      resource dir. Signalled by process.env.O8_BUNDLED_MCP_PATH, which
 *      the Rust sidecar sets before spawning the Next server.
 *
 * Returns:
 *   {
 *     server: { "o8": { command, args, env } },
 *     fullConfig: { "mcpServers": { ... } },
 *     instructions: { claudeDesktop, claudeCode },
 *     diagnostics: { nodeInstalled, codexInstalled, ghInstalled }
 *   }
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { getApiBase, resolvePortInfo } from '@/lib/panel/api-port';

function findCommand(name: string): string | null {
  try {
    const which = execSync(`command -v ${name} 2>/dev/null`, { encoding: 'utf-8' }).trim();
    return which || null;
  } catch {
    return null;
  }
}

function buildServerConfig(): { command: string; args: string[]; env: Record<string, string> } {
  // Bundled packaged app signals this via env var written by the Tauri Rust sidecar.
  const bundled = process.env.O8_BUNDLED_MCP_PATH;
  if (bundled && existsSync(bundled)) {
    // Prefer the node path the Tauri sidecar resolved via login shell
    // (handles nvm/fnm/volta that Finder's minimal PATH misses).
    const nodeBin = process.env.O8_NODE_BIN || findCommand('node') || 'node';
    return {
      command: nodeBin,
      args: [bundled],
      env: { O8_API_BASE: getApiBase() },
    };
  }

  // Dev checkout: use tsx against the TS source.
  const repoRoot = resolve(process.cwd());
  const tsSource = join(repoRoot, 'src', 'lib', 'mcp', 'operator-mcp-server.ts');
  if (!existsSync(tsSource)) {
    // Running outside the repo and no bundled binary — this is a broken install.
    return {
      command: 'npx',
      args: ['tsx', 'src/lib/mcp/operator-mcp-server.ts'],
      env: { O8_API_BASE: getApiBase() },
    };
  }

  const tsxBin = findCommand('tsx');
  if (tsxBin) {
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

function buildInstructions(): { claudeDesktop: string; claudeCode: string } {
  const home = process.env.HOME || '';
  const claudeDesktopConfigPath = process.platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    : process.platform === 'win32'
      ? '%APPDATA%\\Claude\\claude_desktop_config.json'
      : join(home, '.config', 'Claude', 'claude_desktop_config.json');

  return {
    claudeDesktop: [
      `1. Open ${claudeDesktopConfigPath}`,
      '2. Merge the "o8" entry into your existing "mcpServers" object.',
      '3. Fully quit Claude Desktop (⌘Q on macOS) and reopen it.',
      '4. The o8 tools should appear in the /mcp slash menu.',
    ].join('\n'),
    claudeCode: [
      '1. In the project where you want o8 access, save the full config below as `.mcp.json`.',
      '2. Restart Claude Code (or run /mcp reload).',
      '3. The o8 tools should appear in the /mcp slash menu.',
    ].join('\n'),
  };
}

export async function GET() {
  try {
    const server = buildServerConfig();
    const fullConfig = { mcpServers: { o8: server } };

    const nodeBin = findCommand('node');
    const codexBin = findCommand('codex');
    const ghBin = findCommand('gh');
    const portInfo = resolvePortInfo();

    const dataDir = process.env.CORTEX_IDE_DATA_DIR
      || join(process.env.HOME || '', '.cortex-ide');
    const dbPath = join(dataDir, 'cortex-ide.db');
    const dbExists = existsSync(dbPath);
    const dbSize = dbExists ? statSync(dbPath).size : 0;

    return NextResponse.json({
      server,
      fullConfig,
      instructions: buildInstructions(),
      diagnostics: {
        apiBase: getApiBase(),
        apiPort: portInfo.apiPort,
        wsPort: portInfo.wsPort,
        portSource: portInfo.source,
        bundled: Boolean(process.env.O8_BUNDLED_MCP_PATH),
        platform: process.platform,
        nodeInstalled: Boolean(nodeBin),
        nodeBin,
        codexInstalled: Boolean(codexBin),
        codexBin,
        ghInstalled: Boolean(ghBin),
        ghBin,
        dataDir,
        dbExists,
        dbSize,
      },
    });
  } catch (error) {
    console.error('[setup/mcp-config] error:', error);
    return NextResponse.json(
      { error: 'Failed to generate MCP config', detail: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
