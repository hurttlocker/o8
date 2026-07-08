#!/usr/bin/env node
// Build the speech-local sidecar (FluidAudio/Parakeet on-device transcription,
// Apple Silicon only at runtime) and stage it into src-tauri/helpers/ with the
// triple-suffixed names Tauri's externalBin expects. Universal binary: the
// x86_64 slice exists so bundling never breaks, but the Rust caller gates on
// aarch64 — Intel machines never spawn it (benchmarked unusable there).
//
// Best-effort by design: if the Swift toolchain or network (SPM fetch of
// FluidAudio) is unavailable, we KEEP any previously staged binaries and exit
// 0 so a ship isn't blocked; we only hard-fail when there's nothing staged at
// all AND the build failed — that would produce a bundle missing a declared
// externalBin, which tauri build rejects anyway.
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = join(root, 'src-tauri', 'sidecars', 'speech-local');
const helpersDir = join(root, 'src-tauri', 'helpers');
const staged = [
  join(helpersDir, 'speech-local'),
  join(helpersDir, 'speech-local-aarch64-apple-darwin'),
  join(helpersDir, 'speech-local-x86_64-apple-darwin'),
];

if (process.platform !== 'darwin') {
  console.log('[speech-local] non-macOS — skipping');
  process.exit(0);
}

mkdirSync(helpersDir, { recursive: true });

let built = null;
try {
  execSync('swift build -c release --arch arm64 --arch x86_64', {
    cwd: pkgDir,
    stdio: 'inherit',
    timeout: 15 * 60_000,
  });
  const universal = join(pkgDir, '.build', 'apple', 'Products', 'Release', 'speech-local');
  if (existsSync(universal)) built = universal;
} catch (error) {
  console.warn(`[speech-local] universal build failed (${error.message}) — trying arm64-only`);
  try {
    execSync('swift build -c release --arch arm64', { cwd: pkgDir, stdio: 'inherit', timeout: 15 * 60_000 });
    const arm = join(pkgDir, '.build', 'arm64-apple-macosx', 'release', 'speech-local');
    if (existsSync(arm)) built = arm;
  } catch (inner) {
    console.warn(`[speech-local] arm64 build failed too (${inner.message})`);
  }
}

if (built) {
  for (const target of staged) copyFileSync(built, target);
  console.log(`[speech-local] staged ${built} → helpers/ (3 names)`);
} else if (staged.every((p) => existsSync(p))) {
  console.warn('[speech-local] build unavailable — keeping previously staged binaries');
} else {
  console.error('[speech-local] no build and no staged binaries — externalBin would be missing');
  process.exit(1);
}
