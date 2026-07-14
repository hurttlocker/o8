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
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePortInfo } from '@/lib/panel/api-port';
import { externalServerToMcpConfig, listEnabledExternalMcpServers } from '@/lib/mcp/external-servers';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import type { ServerEntry, ToolProfile, ToolRegistry } from './registry';

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

// `moduleDir` is injectable ONLY so the packaged sibling-probe branch below is
// reachable in a unit test (real callers use the default — this module's own
// bundle dir). See build-mcp-resolution.test.ts.
export function findBundledMcpServer(fileName: string, moduleDir?: string): string | null {
  if (fileName === 'operator-mcp-server.mjs') {
    const explicitOperatorPath = process.env.O8_BUNDLED_MCP_PATH;
    if (explicitOperatorPath && existsSync(explicitOperatorPath)) {
      return explicitOperatorPath;
    }
  }

  const bundledDir =
    process.env.O8_BUNDLED_MCP_DIR
    || (process.env.O8_BUNDLED_MCP_PATH ? dirname(process.env.O8_BUNDLED_MCP_PATH) : null);
  if (bundledDir) {
    const bundled = join(bundledDir, fileName);
    if (existsSync(bundled)) {
      return bundled;
    }
  }

  // Defense in depth (belt to the sidecar's suspenders). The Rust sidecar sets
  // O8_BUNDLED_MCP_PATH/DIR for its children — but this exact class already bit
  // once: the next-server child got the vars, the ws-server child (which hosts
  // the in-app orchestrator and thus GENERATES the orchestrator MCP config) did
  // not, so the resolver fell through to a dev `tsx …/*.ts` path absent from the
  // bundle. When esbuild flattens this module into `server/*-impl.mjs`, the
  // bundled operator/cortex `.mjs` sit right beside it — so in any packaged
  // process (O8_PACKAGED_APP=1) resolve the sibling directly, env or no env. A
  // dev checkout has no sibling .mjs, so it still falls through to the tsx source.
  if (process.env.O8_PACKAGED_APP) {
    const baseDir = moduleDir ?? dirname(fileURLToPath(import.meta.url));
    const sibling = resolve(baseDir, fileName);
    if (existsSync(sibling)) {
      return sibling;
    }
  }

  return null;
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

export function resolveToolSpineWsPort(): string {
  // Keep the MCP child on the same port identity as this server process.
  // The former file-first resolver let an unrelated sidecar rewrite of
  // ~/.o8/ws-port override a pinned O8_WS_PORT/WS_PORT and rotate the warm-proc
  // hash even though this process was still listening on its original port.
  return String(resolvePortInfo().wsPort);
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
 *
 * `options.profile` projects the catalog by trust class. `'full'` (default) is
 * today's behavior, BYTE-IDENTICAL to the no-arg call. `'propose'` is the
 * read-only proposer profile (Collide): it strips the operator server (dispatch)
 * and relaunches the MIXED cortex surface read-only (CORTEX_READONLY=1, only its
 * allowlisted read tools survive) — the #1075 lockout (see `ToolProfile`).
 */
export function buildToolRegistry(
  repoPath: string,
  options?: { profile?: ToolProfile },
): ToolRegistry {
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
        WS_PORT: resolveToolSpineWsPort(),
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

  // Profile projection. `'propose'` (Collide's read-only proposer) is the #1075
  // dispatch lockout, applied STRUCTURALLY here:
  //   1. drop the operator server entirely (dispatch_mission / approve_and_merge);
  //   2. drop EVERY external (user-configured) MCP server. o8 can't know which
  //      external tool writes (a Postgres write, a GitHub/Linear mutation), and
  //      these would fire in a consumed proposer side-thread outside the
  //      aggregator's review — so a proposer gets NO external servers at all.
  //      Strip-all, not allowlist: a proposer has native Read/Grep/Glob + the 9
  //      cortex reads, which is all it needs to propose. (A deliberate read-only
  //      external opt-in would be a later feature, never the default.)
  //   3. cortex is a MIXED surface — read tools alongside mutators, most
  //      dangerously `cortex_launch_agent` (it POSTs /api/orchestrator/delegate
  //      and dispatches a worker). It is NOT read-only memory. So we relaunch it
  //      with CORTEX_READONLY=1, which makes the cortex server advertise + accept
  //      ONLY its allowlisted read tools (the dispatch/mutator verbs never reach
  //      the proposer's MCP config). Fail-closed: a cortex tool added later is
  //      hidden until it opts into the allowlist.
  // `'fable'` (the Fable orchestrator) shares the external-strip with `'propose'`
  // but diverges on operator + cortex:
  //   · propose → drop operator (dispatch lockout) + relaunch cortex read-only.
  //   · fable   → KEEP operator (Fable still dispatches) + cortex at full read.
  //     Fable's token lever is Layer B (native read/write tools locked out at the
  //     CLI — see `fable-profile.ts`), NOT the MCP surface, so operator/cortex ride.
  // `'full'` returns the catalog untouched — byte-identical to the legacy no-arg path.
  const profile = options?.profile ?? 'full';
  const stripExternal = profile === 'propose' || profile === 'fable';
  const dropOperator = profile === 'propose';
  const cortexReadonly = profile === 'propose';
  const projected = (stripExternal || dropOperator)
    ? entries
        .filter((entry) => !(dropOperator && entry.id === 'builtin:operator'))
        .filter((entry) => !(stripExternal && entry.source === 'external'))
        .map((entry) =>
          cortexReadonly && entry.id === 'builtin:cortex' && entry.config.type === 'stdio'
            ? { ...entry, config: { ...entry.config, env: { ...entry.config.env, CORTEX_READONLY: '1' } } }
            : entry,
        )
    : entries;

  return { repoPath, entries: projected };
}
