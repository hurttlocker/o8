/**
 * buildToolRegistry — promote o8's live MCP config into the registry shape.
 *
 * This is the ONE place the catalog is assembled. The resolvers below were moved
 * verbatim from `lane/orchestrator-mcp-config.ts` (only the `import.meta.url`
 * relative paths shifted for the new directory depth) + `resolveCodebaseMemoryBin`
 * from the setup routes. Entry order matches today's `getMcpServersConfig`:
 * DB externals first, then operator, then cortex, then codebase-memory.
 *
 * @/lib boundary: this imports DB/ws/api-port, so it must ONLY ever be called
 * from the Next server runtime — never from a standalone `tsx` MCP process
 * (which duplicates `resolveApiBase`). The emitters stay import-pure so they can
 * be copied into such a process if ever needed.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { externalServerToMcpConfig, listEnabledExternalMcpServers } from '@/lib/mcp/external-servers';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import type { ServerEntry, ToolRegistry } from './registry';

/** Resolve repo slug from git remote. */
function detectRepoSlug(repoPath: string): string {
  try {
    const remote = execSync('git remote get-url origin', { cwd: repoPath, timeout: 3000, encoding: 'utf-8' }).trim();
    const match = remote.match(/[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
    return match?.[1] ?? '';
  } catch {
    return '';
  }
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
 * In a packaged Tauri app the TS source isn't shipped — only the esbuild output
 * in `resource_dir/server/cortex-mcp-server.mjs`. The Rust sidecar sets
 * `O8_BUNDLED_MCP_PATH` and `O8_BUNDLED_MCP_DIR` before spawning Next, so we
 * prefer bundled .mjs files when they exist. Dev checkout falls back to the TS
 * source run under `tsx`.
 */
function resolveCortexMcpServerPath(): { command: string; path: string } {
  const bundled = findBundledMcpServer('cortex-mcp-server.mjs');
  if (bundled) {
    const nodeBin = process.env.O8_NODE_BIN || 'node';
    return { command: nodeBin, path: bundled };
  }

  // From src/lib/mcp/tool-spine/ → src/lib/mcp/cortex-mcp-server.ts
  const devSource = resolve(dirname(fileURLToPath(import.meta.url)), '../cortex-mcp-server.ts');
  return { command: 'npx', path: devSource };
}

function resolveOperatorMcpServerPath(): { command: string; path: string } {
  const bundled = findBundledMcpServer('operator-mcp-server.mjs');
  if (bundled) {
    const nodeBin = process.env.O8_NODE_BIN || 'node';
    return { command: nodeBin, path: bundled };
  }

  // From src/lib/mcp/tool-spine/ → src/lib/mcp/operator-mcp-server.ts
  const devSource = resolve(dirname(fileURLToPath(import.meta.url)), '../operator-mcp-server.ts');
  return { command: 'npx', path: devSource };
}

// Binary-resolution shape — read this before any new emission surface that
// resolves the operator/cortex binary (Set-B routes, Gemini/OpenClaw wiring).
//
//   PACKAGED (O8_BUNDLED_MCP_PATH set): { command: <O8_NODE_BIN|node>, args: [<bundled .mjs>] }
//   DEV      (no bundled binary):       { command: "npx",             args: ["tsx", <src .ts>] }
//
// "tsx-vs-npx / spec risk #3": the legacy Set-B builders preferred a resolved
// tsx path (`{command: "/abs/tsx", args: [src]}`) — same server under tsx, a
// different invocation. The registry standardizes on the npx/tsx form, so in DEV
// the emitted shape differs from the old Set-B output (cosmetic, functionally
// equivalent); in PACKAGED mode both collapse to the identical node+bundled
// form. THEREFORE every byte-for-byte parity proof runs in PACKAGED mode — the
// shape that actually ships. (Spec risk register item #3.)
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
  } catch {
    /* fall through */
  }
  return process.env.O8_WS_PORT?.trim() || process.env.WS_PORT?.trim() || '3002';
}

/**
 * Resolve the codebase-memory-mcp binary, falling back from the env var the
 * Tauri sidecar sets (#739) to the deterministic install path. Returns null
 * when neither resolves — the caller omits the entry so cold first launch
 * (binary not yet downloaded) doesn't break session boot.
 */
function resolveCodebaseMemoryBin(): string | null {
  const fromEnv = process.env.O8_CODEBASE_MEMORY_BIN;
  if (fromEnv && fromEnv.trim() && existsSync(fromEnv)) {
    return fromEnv;
  }

  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return null;

  const fileName = process.platform === 'win32' ? 'codebase-memory-mcp.exe' : 'codebase-memory-mcp';
  const deterministic = join(home, '.o8', 'bin', fileName);
  if (existsSync(deterministic)) {
    return deterministic;
  }

  return null;
}

/**
 * Assemble the catalog. Order is load-bearing (emitters preserve it):
 *   1. DB externals     — orchestrator surfaces only
 *   2. operator         — ALL surfaces (renamed "o8" on external surfaces)
 *   3. cortex           — orchestrator surfaces only
 *   4. codebase-memory  — external surfaces only, omitted when the binary is absent
 */
export function buildToolRegistry(repoPath: string): ToolRegistry {
  const repoSlug = detectRepoSlug(repoPath);
  const { getApiBase } = require('@/lib/panel/api-port') as typeof import('@/lib/panel/api-port');
  const apiBase = getApiBase();

  const cortexServer = resolveCortexMcpServerPath();
  const operatorServer = resolveOperatorMcpServerPath();

  const entries: ServerEntry[] = [];

  // 1. DB externals first — matches `{ ...externalServers, operator, cortex }`.
  try {
    for (const server of listEnabledExternalMcpServers()) {
      entries.push({
        id: `external:${server.name}`,
        name: server.name,
        source: 'external',
        label: server.name,
        surfaces: ['claude-orchestrator', 'codex-orchestrator'],
        config: externalServerToMcpConfig(server),
      });
    }
  } catch (error) {
    console.warn(
      `[tool-spine] Failed to load external MCP servers: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // 2. operator — all surfaces; "o8" on the external-facing ones.
  entries.push({
    id: 'builtin:operator',
    name: 'operator',
    source: 'builtin',
    label: 'o8 Operator',
    surfaces: ['claude-orchestrator', 'codex-orchestrator', 'claude-desktop', 'openclaw', 'gemini', 'opencode'],
    surfaceNames: { 'claude-desktop': 'o8', openclaw: 'o8', gemini: 'o8', opencode: 'o8' },
    config: {
      type: 'stdio',
      command: operatorServer.command,
      args: argsForMcpServer(operatorServer),
      env: {
        O8_API_BASE: apiBase,
      },
    },
  });

  // 3. cortex — orchestrator surfaces only.
  entries.push({
    id: 'builtin:cortex',
    name: 'cortex',
    source: 'builtin',
    label: 'Cortex Memory',
    surfaces: ['claude-orchestrator', 'codex-orchestrator'],
    config: {
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
  });

  // 4. codebase-memory — external surfaces only, omitted when the binary is absent.
  const codebaseMemoryBin = resolveCodebaseMemoryBin();
  if (codebaseMemoryBin) {
    entries.push({
      id: 'builtin:codebase-memory',
      name: 'codebase-memory',
      source: 'builtin',
      label: 'Codebase Memory',
      surfaces: ['claude-desktop', 'gemini', 'opencode'],
      config: {
        type: 'stdio',
        command: codebaseMemoryBin,
        args: [],
        env: {},
      },
    });
  }

  return { repoPath, entries };
}
