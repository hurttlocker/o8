import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { externalServerToMcpConfig, listEnabledExternalMcpServers } from '@/lib/mcp/external-servers';
import type { OrchestratorMcpServerConfig } from '@/lib/mcp/external-servers';
import { getOrCreateWsToken } from '@/lib/ws-auth';

export type OrchestratorMcpServersConfig = Record<string, OrchestratorMcpServerConfig>;

/** Resolve repo slug from git remote, cached per session. */
function detectRepoSlug(repoPath: string): string {
  try {
    const remote = execSync('git remote get-url origin', { cwd: repoPath, timeout: 3000, encoding: 'utf-8' }).trim();
    const match = remote.match(/[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
    return match?.[1] ?? '';
  } catch { return ''; }
}

function findBundledMcpServer(fileName: string): string | null {
  if (fileName === 'operator-mcp-server.mjs') {
    const explicitOperatorPath = process.env.O8_BUNDLED_MCP_PATH;
    if (explicitOperatorPath && existsSync(explicitOperatorPath)) {
      return explicitOperatorPath;
    }
  }

  const bundledDir =
    process.env.O8_BUNDLED_MCP_DIR
    || (process.env.O8_BUNDLED_MCP_PATH ? dirname(process.env.O8_BUNDLED_MCP_PATH) : null);
  if (!bundledDir) {
    return null;
  }

  const bundled = join(bundledDir, fileName);
  return existsSync(bundled) ? bundled : null;
}

/**
 * Resolve the Cortex MCP server entry point.
 *
 * In a packaged Tauri app the TS source isn't shipped — only the esbuild
 * output in `resource_dir/server/cortex-mcp-server.mjs`. The Rust sidecar
 * sets `O8_BUNDLED_MCP_PATH` and `O8_BUNDLED_MCP_DIR` before spawning Next, so
 * we prefer bundled .mjs files when they exist.
 *
 * Dev checkout falls back to the TS source run under `tsx`.
 */
function resolveCortexMcpServerPath(): { command: string; path: string } {
  const bundled = findBundledMcpServer('cortex-mcp-server.mjs');
  if (bundled) {
    const nodeBin = process.env.O8_NODE_BIN || 'node';
    return { command: nodeBin, path: bundled };
  }

  const devSource = resolve(dirname(fileURLToPath(import.meta.url)), '../mcp/cortex-mcp-server.ts');
  return { command: 'npx', path: devSource };
}

function resolveOperatorMcpServerPath(): { command: string; path: string } {
  const bundled = findBundledMcpServer('operator-mcp-server.mjs');
  if (bundled) {
    const nodeBin = process.env.O8_NODE_BIN || 'node';
    return { command: nodeBin, path: bundled };
  }

  const devSource = resolve(dirname(fileURLToPath(import.meta.url)), '../mcp/operator-mcp-server.ts');
  return { command: 'npx', path: devSource };
}

function argsForMcpServer(server: { command: string; path: string }): string[] {
  return server.command === 'npx' ? ['tsx', server.path] : [server.path];
}

function resolveWsPort(): string {
  try {
    const dataDir = process.env.CORTEX_IDE_DATA_DIR || join(homedir(), '.o8');
    const portFile = join(dataDir, 'ws-port');
    if (existsSync(portFile)) {
      const raw = readFileSync(portFile, 'utf-8').trim();
      const n = parseInt(raw, 10);
      if (Number.isInteger(n) && n > 0 && n < 65536) {
        return String(n);
      }
    }
  } catch { /* fall through */ }
  return process.env.O8_WS_PORT?.trim() || process.env.WS_PORT?.trim() || '3002';
}

export function getMcpServersConfig(repoPath: string): OrchestratorMcpServersConfig {
  const repoSlug = detectRepoSlug(repoPath);
  const { getApiBase } = require('@/lib/panel/api-port') as typeof import('@/lib/panel/api-port');
  const apiBase = getApiBase();

  const cortexServer = resolveCortexMcpServerPath();
  const operatorServer = resolveOperatorMcpServerPath();

  const externalServers: OrchestratorMcpServersConfig = {};
  try {
    for (const server of listEnabledExternalMcpServers()) {
      externalServers[server.name] = externalServerToMcpConfig(server);
    }
  } catch (error) {
    console.warn(
      `[orchestrator-mcp-config] Failed to load external MCP servers: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    ...externalServers,
    operator: {
      type: 'stdio',
      command: operatorServer.command,
      args: argsForMcpServer(operatorServer),
      env: {
        O8_API_BASE: apiBase,
      },
    },
    cortex: {
      type: 'stdio',
      command: cortexServer.command,
      args: argsForMcpServer(cortexServer),
      env: {
        CORTEX_API_BASE: apiBase,
        CORTEX_REPO_PATH: repoPath,
        CORTEX_REPO_SLUG: repoSlug,
        WS_PORT: resolveWsPort(),
        WS_TOKEN: getOrCreateWsToken(),
      },
    },
  };
}
