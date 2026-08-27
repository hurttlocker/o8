#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import {
  captureReleaseBuildCache,
  collectReleaseBuildCacheIdentity,
  createReleaseBuildCacheRunId,
  finalizeReleaseBuildCacheReceipt,
  resolveReleaseBuildCacheRoot,
  restoreReleaseBuildCache,
  writeReleaseBuildCachePhaseReceipt,
} from './lib/release-build-cache.mjs';

const root = process.cwd();
const startedAt = Date.now();
const runId = createReleaseBuildCacheRunId();
const cacheRoot = resolveReleaseBuildCacheRoot();
const cargoTauriArgs = process.argv.slice(2);
const nativeBuildOptions = { cargoTauriArgs };
const prebuildMarker = join(cacheRoot, 'runs', runId, 'prebuild-completed-at');
let nativeIdentity;
let nativeRestore;

try {
  nativeIdentity = collectReleaseBuildCacheIdentity(root, 'native', { buildOptions: nativeBuildOptions });
  nativeRestore = await restoreReleaseBuildCache(root, 'native', {
    cacheRoot,
    identity: nativeIdentity,
    buildOptions: nativeBuildOptions,
  });
} catch (error) {
  nativeRestore = {
    phase: 'native',
    status: 'miss',
    reason: `cache_unavailable:${error instanceof Error ? error.message : String(error)}`,
    durationMs: Date.now() - startedAt,
  };
}
console.log(
  `[release-cache] native restore=${nativeRestore.status} reason=${nativeRestore.reason}`
  + ` bytes=${nativeRestore.archiveBytes ?? 0} duration=${nativeRestore.durationMs}ms`,
);
writeReleaseBuildCachePhaseReceipt(cacheRoot, runId, { phase: 'native', restore: nativeRestore });

const env = {
  ...process.env,
  O8_RELEASE_BUILD_CACHE_DIR: cacheRoot,
  O8_RELEASE_CACHE_RUN_ID: runId,
  O8_RELEASE_CACHE_PREBUILD_MARKER: prebuildMarker,
};
const build = spawnSync('cargo', ['tauri', 'build', ...cargoTauriArgs], {
  cwd: root,
  env,
  stdio: 'inherit',
});
const buildDurationMs = Date.now() - startedAt;
const prebuildCompletedAt = existsSync(prebuildMarker)
  ? Number.parseInt(readFileSync(prebuildMarker, 'utf8').trim(), 10)
  : Number.NaN;
const nativeBuildDurationMs = Number.isFinite(prebuildCompletedAt)
  ? Math.max(0, Date.now() - prebuildCompletedAt)
  : buildDurationMs;
let nativeCapture;
if (!build.error && build.status === 0) {
  try {
    nativeIdentity = nativeIdentity ?? collectReleaseBuildCacheIdentity(root, 'native', { buildOptions: nativeBuildOptions });
    nativeCapture = await captureReleaseBuildCache(root, 'native', {
      cacheRoot,
      identity: nativeIdentity,
      buildDurationMs: nativeBuildDurationMs,
      buildOptions: nativeBuildOptions,
    });
  } catch (error) {
    nativeCapture = {
      phase: 'native',
      status: 'miss',
      reason: `capture_unavailable:${error instanceof Error ? error.message : String(error)}`,
      durationMs: 0,
    };
  }
  console.log(
    `[release-cache] native capture=${nativeCapture.status} reason=${nativeCapture.reason}`
    + ` bytes=${nativeCapture.archiveBytes ?? 0} duration=${nativeCapture.durationMs}ms`,
  );
  writeReleaseBuildCachePhaseReceipt(cacheRoot, runId, {
    phase: 'native',
    restore: nativeRestore,
    buildDurationMs: nativeBuildDurationMs,
    capture: nativeCapture,
  });
}

let finalized;
try {
  finalized = finalizeReleaseBuildCacheReceipt(cacheRoot, runId, {
    outcome: !build.error && build.status === 0 ? 'PASS' : 'FAIL',
    source: nativeIdentity?.source ?? { head: 'unavailable' },
    buildDurationMs,
  });
  const totals = finalized.receipt.totals ?? {};
  console.log(
    `[release-cache] receipt ${finalized.receiptPath}`
    + ` hits=${totals.hits ?? 0} misses=${totals.misses ?? 0}`
    + ` restored=${totals.archiveBytesRestored ?? 0} estimated-saved=${totals.estimatedSavedMs ?? 0}ms`,
  );
} catch (error) {
  console.warn(`[release-cache] receipt unavailable: ${error instanceof Error ? error.message : String(error)}`);
}

if (build.error) throw build.error;
process.exit(build.status ?? 1);
