import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { devMcpServerLaunch, findBundledMcpServer } from './build';

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
    const bundleDir = tempBundleDir(['operator-mcp-server.mjs', 'operator-mcp-proxy.mjs', 'cortex-mcp-server.mjs']);

    expect(findBundledMcpServer('operator-mcp-server.mjs', bundleDir)).toBe(
      join(bundleDir, 'operator-mcp-server.mjs'),
    );
    expect(findBundledMcpServer('cortex-mcp-server.mjs', bundleDir)).toBe(
      join(bundleDir, 'cortex-mcp-server.mjs'),
    );
    expect(findBundledMcpServer('operator-mcp-proxy.mjs', bundleDir)).toBe(
      join(bundleDir, 'operator-mcp-proxy.mjs'),
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
    const bundleDir = tempBundleDir(['operator-mcp-server.mjs', 'operator-mcp-proxy.mjs', 'cortex-mcp-server.mjs']);
    process.env.O8_BUNDLED_MCP_DIR = bundleDir;
    expect(findBundledMcpServer('operator-mcp-server.mjs')).toBe(join(bundleDir, 'operator-mcp-server.mjs'));
    expect(findBundledMcpServer('operator-mcp-proxy.mjs')).toBe(join(bundleDir, 'operator-mcp-proxy.mjs'));
    expect(findBundledMcpServer('cortex-mcp-server.mjs')).toBe(join(bundleDir, 'cortex-mcp-server.mjs'));
  });

  it('returns null when neither env nor a packaged sibling resolves', () => {
    clearMcpEnv();
    expect(findBundledMcpServer('operator-mcp-server.mjs')).toBeNull();
    expect(findBundledMcpServer('cortex-mcp-server.mjs')).toBeNull();
  });
});

async function listDevServerTools(sourcePath: string, cwd: string, dataDir: string): Promise<{ initialized: boolean; tools: string[] }> {
  const launch = devMcpServerLaunch(sourcePath);
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      cwd,
      env: {
        ...process.env,
        O8_DATA_DIR: dataDir,
        NODE_OPTIONS: '--conditions=react-server',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    let initialized = false;
    let stderr = '';
    const finish = (error?: Error, tools?: string[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill('SIGTERM');
      if (error) reject(error);
      else resolve({ initialized, tools: tools ?? [] });
    };
    const timeout = setTimeout(() => finish(new Error(`MCP tools/list timed out: ${stderr.slice(0, 500)}`)), 20_000);
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        const message = JSON.parse(line) as { id?: number; result?: { tools?: Array<{ name: string }> } };
        if (message.id === 1 && message.result) initialized = true;
        if (message.id === 2) finish(undefined, message.result?.tools?.map((tool) => tool.name));
      } catch { /* Ignore non-protocol logging. */ }
    });
    child.on('error', (error) => finish(error));
    child.on('exit', (code) => {
      if (!settled) finish(new Error(`MCP server exited ${code}: ${stderr.slice(0, 500)}`));
    });
    for (const request of [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]) child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

describe('dev orchestrator MCP servers from another checkout', () => {
  it('loads the Fast delegation tool with the o8 tsconfig when the agent cwd is an unrelated repo', async () => {
    clearMcpEnv();
    const agentRepo = tempBundleDir([]);
    const dataDir = tempBundleDir([]);
    const mcpDir = dirname(fileURLToPath(new URL('../cortex-mcp-server.ts', import.meta.url)));
    const cortexTools = await listDevServerTools(join(mcpDir, 'cortex-mcp-server.ts'), agentRepo, dataDir);

    expect(cortexTools.initialized).toBe(true);
    expect(cortexTools.tools).toContain('cortex_launch_agent');
    expect(devMcpServerLaunch(join(mcpDir, 'operator-mcp-proxy.ts')).args).toContain(join(mcpDir, 'operator-mcp-proxy.ts'));
  }, 45_000);
});
