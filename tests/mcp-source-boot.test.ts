/**
 * Real-path boot smoke for the SOURCE-LAUNCHED MCP servers (reachability
 * doctrine, launch seam).
 *
 * The operator MCP runs in two module systems: bundled ESM in packaged
 * installs, and CommonJS when launched from repo source via tsx (no
 * `"type": "module"` in package.json) — which is exactly how the
 * com.rainwater.mcp-o8 LaunchAgent and any dev .mcp.json run it. ESM-only
 * syntax (top-level await, etc.) passes tsc and the bundled path but dies at
 * module load on the source path; with LaunchAgent KeepAlive that became a
 * silent 4-day crash loop (102 failed starts in one gateway log,
 * 2026-07-10). Nothing else in the suite exercises this launch shape.
 *
 * The test spawns the REAL entry with tsx and asserts the process survives
 * module load. A load-time crash exits within a second or two; a healthy
 * stdio MCP server parks on stdin indefinitely.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-mcp-boot-'));

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function bootSurvives(entry: string): Promise<{ alive: boolean; exitCode: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', entry], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CORTEX_IDE_DATA_DIR: dataDir,
        O8_DATA_DIR: dataDir,
        // Keep the node22 re-exec shim from spawning a second process tree —
        // the test asserts THIS process's module load, not the shim.
        O8_MCP_NODE22_CHECKED: '1',
        O8_API_BASE: 'http://127.0.0.1:9', // discard port — boot must not need a live API
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ alive: true, exitCode: null, stderr });
    }, 12_000);

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ alive: false, exitCode: code, stderr });
    });
  });
}

function bootWithMissingInstalledAnchor(
  entry: string,
  launcherPath: string,
  dataPath: string,
  bundledPath: string,
): Promise<{ exitCode: number | null; stderr: string }> {
  return new Promise((resolve) => {
    writeFileSync(launcherPath, `await import(${JSON.stringify(pathToFileURL(resolvePath(entry)).href)});\n`);
    const child = spawn('npx', ['tsx', launcherPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CORTEX_IDE_DATA_DIR: dataPath,
        O8_DATA_DIR: dataPath,
        O8_BUNDLED_MCP_PATH: bundledPath,
        O8_BUNDLED_MCP_DIR: dirname(bundledPath),
        O8_MCP_NODE22_CHECKED: '1',
        WS_TOKEN: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ exitCode: null, stderr });
    }, 5_000);

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stderr });
    });
  });
}

describe('source-launched MCP servers survive module load (tsx/CJS path)', () => {
  it('operator MCP server boots from source without a load-time crash', async () => {
    const result = await bootSurvives('src/lib/mcp/operator-mcp-server.ts');
    expect(result.alive, `operator MCP exited at load (code ${result.exitCode}):\n${result.stderr.slice(0, 1500)}`).toBe(true);
  }, 20_000);

  it('cortex MCP server boots from source without a load-time crash', async () => {
    const result = await bootSurvives('src/lib/mcp/cortex-mcp-server.ts');
    expect(result.alive, `cortex MCP exited at load (code ${result.exitCode}):\n${result.stderr.slice(0, 1500)}`).toBe(true);
  }, 20_000);

  it.each([
    ['operator', 'src/lib/mcp/operator-mcp-server.ts'],
    ['cortex', 'src/lib/mcp/cortex-mcp-server.ts'],
  ])('%s MCP exits before recreating data when its installed app anchor is gone', async (_label, entry) => {
    const root = mkdtempSync(join(os.tmpdir(), 'o8-mcp-uninstall-'));
    const launcherPath = join(root, `${_label}-launcher.mjs`);
    const missingDataPath = join(root, 'data-must-not-exist');
    const bundledPath = join(root, 'o8.app', 'Contents', 'Resources', 'server', `${_label}-mcp-server.mjs`);
    try {
      const result = await bootWithMissingInstalledAnchor(entry, launcherPath, missingDataPath, bundledPath);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toContain('installed o8.app is missing');
      expect(existsSync(missingDataPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});
