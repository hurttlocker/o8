#!/usr/bin/env node
/**
 * Next's persistent webpack cache treats node_modules as immutable (managed
 * paths keyed by package version), so patch-package edits do NOT invalidate
 * cached module chunks — a patched dependency can silently ship UNPATCHED.
 * Live-hit 2026-07-05: the tauri-plugin-clerk fetch-interceptor fix landed in
 * node_modules + patches/, but v0.1.540 bundled the stale pre-patch chunk
 * (identical content hash to v0.1.538) and the dashboard stayed broken.
 *
 * Guard: if anything under patches/ is newer than the webpack cache, drop the
 * cache before `next build`. Runs as part of the build script — costs nothing
 * when there are no fresh patches.
 */

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const patchesDir = join(root, 'patches');
const cacheDir = join(root, '.next', 'cache');

if (!existsSync(patchesDir) || !existsSync(cacheDir)) {
  process.exit(0);
}

const newestPatchMs = readdirSync(patchesDir)
  .map((name) => statSync(join(patchesDir, name)).mtimeMs)
  .reduce((max, ms) => Math.max(max, ms), 0);

const cacheMs = statSync(cacheDir).mtimeMs;

if (newestPatchMs > cacheMs) {
  console.log('[bust-stale-patch-cache] patches/ newer than .next/cache — clearing webpack cache so patched dependencies rebundle');
  // Build systems can mount `.next/cache` as a persistent cache volume. Removing
  // the mount root fails with EBUSY on Linux, while removing its contents keeps
  // the mount intact and invalidates the same webpack artifacts.
  for (const entry of readdirSync(cacheDir)) {
    rmSync(join(cacheDir, entry), { recursive: true, force: true });
  }
}
