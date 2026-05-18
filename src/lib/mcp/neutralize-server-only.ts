/**
 * Neutralize the `server-only` marker package for standalone MCP processes.
 *
 * o8's MCP servers (`operator-mcp-server.ts`, `cortex-mcp-server.ts`) share
 * library code with the Next.js backend — including SQLite access, lane logic,
 * Cortex retrieval, GitHub plumbing, and more. Dozens of those shared modules
 * begin with `import 'server-only'` so a Next.js build fails fast if they ever
 * leak into a client bundle.
 *
 * The `server-only` npm package is, at runtime, a bare `throw`. Next.js never
 * hits that throw: its bundler aliases `server-only` to an empty module for
 * server layers and to an error-loader for client layers. But an MCP server
 * launched as a plain Node process — in dev, via `tsx` directly on the
 * TypeScript source (see the dev branch of `/api/setup/mcp-config`, which
 * emits `tsx src/lib/mcp/operator-mcp-server.ts`) — has no bundler, so the
 * first transitively-imported `server-only` module detonates the process
 * before it can speak the MCP protocol.
 *
 * The packaged build already solves this: `scripts/tauri-export.mjs` bundles
 * the MCP servers with esbuild and passes `--alias:server-only=…stub`, so the
 * shipped `out/server/*.mjs` never see the real package. Only the dev/source
 * `tsx` launch was left without parity.
 *
 * This module restores that parity for the `tsx` path. It patches CommonJS
 * module resolution (`tsx` transpiles every `.ts` to CJS, so all imports
 * resolve through `Module._load`) so any request for `server-only` returns an
 * inert empty module instead of the throwing one. It is the exact runtime
 * equivalent of the esbuild alias the bundle already uses.
 *
 * Scope is intentionally tiny and safe:
 *   - It runs ONLY inside the standalone MCP process — the Next.js app never
 *     imports an MCP server entry file, so the client-bundle `server-only`
 *     guard is completely unaffected.
 *   - In the esbuild bundle `server-only` is already aliased to an empty stub
 *     and inlined, so the request string `server-only` never reaches this
 *     patch there — the patch is simply inert.
 *   - It only ever intercepts the exact request string `server-only`;
 *     every other module resolves normally.
 *
 * MUST be the first import of each MCP server entry file so the patch is
 * installed before any `server-only`-importing module is resolved. ES module
 * import graphs evaluate depth-first in source order, so a first-position
 * import guarantees this.
 */

import { Module } from 'node:module';

// `Module._load` is the private CommonJS loader hook — stable across Node
// 18–22 and the mechanism every CJS interop shim uses. It is not in the public
// `node:module` types, so the cast is required.
type ModuleLoad = (request: string, parent: unknown, isMain: boolean) => unknown;
type ModuleWithLoad = { _load: ModuleLoad };

const INERT_SERVER_ONLY_MARKER = '__o8ServerOnlyNeutralized';
type PatchableModuleLoad = ModuleLoad & { [INERT_SERVER_ONLY_MARKER]?: true };

const moduleLoader = Module as unknown as ModuleWithLoad;
const currentLoad = moduleLoader._load as PatchableModuleLoad;

// Idempotent: if both MCP entry files (or a re-import) install the patch,
// only the first one takes effect.
if (!currentLoad[INERT_SERVER_ONLY_MARKER]) {
  const originalLoad = currentLoad;

  const patchedLoad: PatchableModuleLoad = function patchedModuleLoad(
    request: string,
    parent: unknown,
    isMain: boolean,
  ): unknown {
    if (request === 'server-only') {
      // Inert stand-in — the marker has nothing to enforce in a non-bundler
      // Node process. Mirrors `scripts/server-only-stub.js`.
      return {};
    }
    return originalLoad(request, parent, isMain);
  };

  patchedLoad[INERT_SERVER_ONLY_MARKER] = true;
  moduleLoader._load = patchedLoad;
}

export {};
