import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function runStep(label, command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });

  if (result.status !== 0) {
    console.warn(`[postinstall] ${label} failed with exit code ${result.status ?? 'unknown'}`);
  }
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

runStep('better-sqlite3 rebuild', 'npm', ['rebuild', 'better-sqlite3']);
runStep('node-pty rebuild', 'npx', ['node-gyp', 'rebuild', '--directory=node_modules/node-pty']);
ensureMonacoCodiconFont();
