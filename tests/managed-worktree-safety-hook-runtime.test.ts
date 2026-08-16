import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import {
  managedWorkspaceSafetyHooksContent,
  resolveManagedWorkspaceSafetyHookRuntime,
} from '@/lib/worktree/safety-hooks';

const parent = path.join(os.tmpdir(), "o8 hook's packaged runtime");
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(path.join(parent, 'case-'));
const serverRoot = path.join(root, 'server');

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('managed worktree safety-hook runtime', () => {
  it('exports and executes the packaged hook runtime with exact quoted paths', async () => {
    const tauriConfig = JSON.parse(readFileSync(
      path.join(process.cwd(), 'src-tauri', 'tauri.conf.json'),
      'utf8',
    )) as { bundle: { resources: Record<string, string> } };
    expect(tauriConfig.bundle.resources['../out/server']).toBe('server/');
    expect(readFileSync(path.join(process.cwd(), 'scripts', 'tauri-export.mjs'), 'utf8'))
      .toContain('exportTauriSafetyHookResources(root, server)');
    const helperUrl = pathToFileURL(
      path.join(process.cwd(), 'scripts', 'tauri-hook-resources.mjs'),
    ).href;
    execFileSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `const { exportTauriSafetyHookResources } = await import(${JSON.stringify(helperUrl)}); exportTauriSafetyHookResources(process.argv[1], process.argv[2]);`,
      process.cwd(),
      serverRoot,
    ]);

    const runtime = await resolveManagedWorkspaceSafetyHookRuntime({
      runtimeRoot: serverRoot,
      packaged: true,
      nodePath: process.execPath,
    });
    expect(Object.values(runtime.hookPaths).every((hookPath) => existsSync(hookPath))).toBe(true);

    const settings = JSON.parse(managedWorkspaceSafetyHooksContent(runtime)) as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    const command = settings.hooks.PreToolUse[0]!.hooks[0]!.command;
    const executed = spawnSync('/bin/sh', ['-c', command], {
      cwd: root,
      encoding: 'utf8',
      input: JSON.stringify({
        session_id: 'safety-hook-runtime-proof',
        tool_name: 'Bash',
        tool_input: { command: 'git status --short' },
        tool_use_id: 'tool-proof',
      }),
    });
    expect(executed.status, executed.stderr).toBe(0);
    expect(JSON.parse(executed.stdout.trim())).toMatchObject({ decision: 'approve' });
  });

  it('fails closed when the packaged hook resources are absent', async () => {
    await expect(resolveManagedWorkspaceSafetyHookRuntime({
      runtimeRoot: path.join(root, 'missing'),
      packaged: true,
      nodePath: process.execPath,
    })).rejects.toThrow(/no complete safety-hook runtime/);
  });
});
