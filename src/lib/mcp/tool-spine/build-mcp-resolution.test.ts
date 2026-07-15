import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { findBundledMcpServer } from './build';

// Regression guard for the packaged-build defect where the in-app orchestrator's
// generated MCP config pointed at dev `tsx …/*.ts` paths that don't ship in the
// bundle, so the orchestrator launched with ZERO o8/cortex tools ("MCP tool
// bridge is not live" + FALSE-DISPATCH). Root cause: the Rust sidecar set
// O8_BUNDLED_MCP_PATH/DIR only on the next-server child, NOT the ws-server child
// that hosts orchestrator sessions and WRITES that config. findBundledMcpServer
// is the resolution seam every orchestrator turn reaches (resolveOperator/
// CortexMcpServerPath are thin command-prefix wrappers over it, consumed by
// buildToolRegistry). The fix: give the ws-server child the env (lib.rs) AND make
// the resolver find the bundled .mjs env-independently in any packaged process.

const ENV_KEYS = ['O8_BUNDLED_MCP_PATH', 'O8_BUNDLED_MCP_DIR', 'O8_PACKAGED_APP', 'O8_NODE_BIN', 'CORTEX_IDE_DATA_DIR'] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
const tempDirs: string[] = [];

function clearMcpEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

function tempBundleDir(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'o8-mcp-bundle-'));
  tempDirs.push(dir);
  for (const f of files) writeFileSync(join(dir, f), '// stub\n');
  return dir;
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('findBundledMcpServer — packaged orchestrator MCP resolution', () => {
  it('resolves the sibling .mjs in a packaged process with NO env vars (the ws-server bug scenario)', () => {
    // Exactly the failure: ws-server child, O8_PACKAGED_APP=1 but the sidecar
    // never propagated O8_BUNDLED_MCP_PATH/DIR. The resolver must still find the
    // bundled server sitting beside the module, not fall to a nonexistent .ts.
    clearMcpEnv();
    process.env.O8_PACKAGED_APP = '1';
    const bundleDir = tempBundleDir(['operator-mcp-server.mjs', 'cortex-mcp-server.mjs']);

    expect(findBundledMcpServer('operator-mcp-server.mjs', bundleDir)).toBe(
      join(bundleDir, 'operator-mcp-server.mjs'),
    );
    expect(findBundledMcpServer('cortex-mcp-server.mjs', bundleDir)).toBe(
      join(bundleDir, 'cortex-mcp-server.mjs'),
    );
  });

  it('returns null in a dev checkout (not packaged), so callers fall through to the tsx source', () => {
    clearMcpEnv();
    // No O8_PACKAGED_APP → the sibling probe is skipped even if a .mjs exists.
    const bundleDir = tempBundleDir(['operator-mcp-server.mjs']);
    expect(findBundledMcpServer('operator-mcp-server.mjs', bundleDir)).toBeNull();
  });

  it('still honors O8_BUNDLED_MCP_DIR (control-flow change did not drop the env path)', () => {
    clearMcpEnv();
    const bundleDir = tempBundleDir(['operator-mcp-server.mjs', 'cortex-mcp-server.mjs']);
    process.env.O8_BUNDLED_MCP_DIR = bundleDir;
    expect(findBundledMcpServer('operator-mcp-server.mjs')).toBe(join(bundleDir, 'operator-mcp-server.mjs'));
    expect(findBundledMcpServer('cortex-mcp-server.mjs')).toBe(join(bundleDir, 'cortex-mcp-server.mjs'));
  });

  it('returns null when neither env nor a packaged sibling resolves', () => {
    clearMcpEnv();
    expect(findBundledMcpServer('operator-mcp-server.mjs')).toBeNull();
    expect(findBundledMcpServer('cortex-mcp-server.mjs')).toBeNull();
  });
});
