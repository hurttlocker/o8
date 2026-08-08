import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function runStep(label, command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    // npm/npx are .cmd shims on Windows — spawnSync can't exec them without a
    // shell (and Node ≥20.12 refuses to). Args here are simple, no quoting risk.
    shell: process.platform === 'win32',
  });

  if (result.status !== 0) {
    const reason = result.error ? result.error.message : `exit code ${result.status ?? 'unknown'}`;
    console.warn(`[postinstall] ${label} failed: ${reason}`);
  }
}

function nativeModuleLoads(moduleName) {
  const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(moduleName)})`], {
    cwd: root,
    stdio: 'ignore',
    env: process.env,
  });
  return result.status === 0;
}

function ensureMonacoCodiconFont() {
  const source = path.join(root, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.ttf');
  const target = path.join(
    root,
    'node_modules',
    'monaco-editor',
    'esm',
    'vs',
    'base',
    'browser',
    'ui',
    'codicons',
    'codicon',
    'codicon.ttf',
  );

  if (!existsSync(source)) {
    console.warn('[postinstall] @vscode/codicons font not found; skipping Monaco codicon repair');
    return;
  }

  const targetMissing = !existsSync(target);
  const targetEmpty = existsSync(target) && statSync(target).size === 0;
  if (!targetMissing && !targetEmpty) {
    return;
  }

  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(source, target);
  console.log('[postinstall] Repaired Monaco codicon.ttf');
}

if (nativeModuleLoads('better-sqlite3')) {
  console.log('[postinstall] better-sqlite3 native module ready');
} else {
  runStep('better-sqlite3 rebuild', 'npm', ['rebuild', 'better-sqlite3']);
}
if (nativeModuleLoads('node-pty')) {
  console.log('[postinstall] node-pty native module ready');
} else {
  runStep('node-pty rebuild', 'npx', ['node-gyp', 'rebuild', '--directory=node_modules/node-pty']);
}
// Re-apply local patches against registry-published dependencies. The
// tauri-plugin-mcp patch fixes React onClick compatibility for the webview
// click tool — see patches/tauri-plugin-mcp+0.1.0.patch.
runStep('patch-package', 'npx', ['patch-package']);
ensureMonacoCodiconFont();
