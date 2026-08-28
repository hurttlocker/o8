#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectReleaseArtifactRecipe,
  verifyReleaseArtifactManifest,
  writeReleaseArtifactManifest,
} from './lib/release-artifacts.mjs';
import {
  captureReleaseBuildCache,
  collectReleaseBuildCacheIdentity,
  createReleaseBuildCacheRunId,
  finalizeReleaseBuildCacheReceipt,
  isReleaseBuildCacheSafetyError,
  resolveReleaseBuildCacheRoot,
  restoreReleaseBuildCache,
  writeReleaseBuildCachePhaseReceipt,
} from './lib/release-build-cache.mjs';
import { resolveReleaseConfig } from './lib/release-config.mjs';

const root = process.cwd();
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const releaseConfig = resolveReleaseConfig(root);
const ownedDataDir = !process.env.O8_DATA_DIR || !process.env.CORTEX_IDE_DATA_DIR
  ? mkdtempSync(join(tmpdir(), 'o8-tauri-build-data-'))
  : null;
const env = {
  ...process.env,
  O8_DATA_DIR: process.env.O8_DATA_DIR || ownedDataDir,
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR || ownedDataDir,
};
if (!env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && releaseConfig.clerkPublishableKey) {
  env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = releaseConfig.clerkPublishableKey;
  console.log('[tauri-prebuild] Clerk publishable key loaded from release config');
}
const cacheRoot = resolveReleaseBuildCacheRoot(env);
const cacheRunId = env.O8_RELEASE_CACHE_RUN_ID || createReleaseBuildCacheRunId();
const ownsCacheRun = !env.O8_RELEASE_CACHE_RUN_ID;
const prebuildStartedAt = Date.now();
let cacheSource = { head: 'unavailable' };
let cacheOutcome = 'FAIL';

function phase(label, command, args) {
  const started = Date.now();
  console.log(`[tauri-prebuild] ${label} started`);
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit ${result.status ?? 'unknown'} after ${seconds}s`);
  console.log(`[tauri-prebuild] ${label} completed in ${seconds}s`);
  return Date.now() - started;
}

async function cachedPhase(cachePhase, label, command, args) {
  const identityOptions = cachePhase === 'web' ? { env } : {};
  let identity;
  let restore;
  try {
    identity = collectReleaseBuildCacheIdentity(root, cachePhase, identityOptions);
    cacheSource = identity.source;
    restore = await restoreReleaseBuildCache(root, cachePhase, { cacheRoot, identity });
  } catch (error) {
    if (isReleaseBuildCacheSafetyError(error)) throw error;
    restore = {
      phase: cachePhase,
      status: 'miss',
      reason: `cache_unavailable:${error instanceof Error ? error.message : String(error)}`,
      durationMs: 0,
    };
  }
  console.log(
    `[release-cache] ${cachePhase} restore=${restore.status} reason=${restore.reason}`
    + ` bytes=${restore.archiveBytes ?? 0} duration=${restore.durationMs}ms`,
  );
  const buildDurationMs = phase(label, command, args);
  let capture;
  try {
    identity = identity ?? collectReleaseBuildCacheIdentity(root, cachePhase, identityOptions);
    capture = await captureReleaseBuildCache(root, cachePhase, {
      cacheRoot,
      identity,
      buildDurationMs,
    });
  } catch (error) {
    if (isReleaseBuildCacheSafetyError(error)) throw error;
    capture = {
      phase: cachePhase,
      status: 'miss',
      reason: `capture_unavailable:${error instanceof Error ? error.message : String(error)}`,
      durationMs: 0,
    };
  }
  console.log(
    `[release-cache] ${cachePhase} capture=${capture.status} reason=${capture.reason}`
    + ` bytes=${capture.archiveBytes ?? 0} duration=${capture.durationMs}ms`,
  );
  writeReleaseBuildCachePhaseReceipt(cacheRoot, cacheRunId, {
    phase: cachePhase,
    restore,
    buildDurationMs,
    capture,
  });
}

try {
  phase('stale-build preflight', process.execPath, ['scripts/preship-cleanup.mjs']);
  const recipe = collectReleaseArtifactRecipe(root, version, { env });
  cacheSource = { head: recipe.head };
  const verification = verifyReleaseArtifactManifest(root, recipe);
  if (verification.reusable) {
    console.log(`[tauri-prebuild] reused verified artifact ${recipe.recipeSha256.slice(0, 16)} (${verification.manifest.outputs.length} checksums)`);
    for (const cachePhase of ['speech', 'web']) {
      writeReleaseBuildCachePhaseReceipt(cacheRoot, cacheRunId, {
        phase: cachePhase,
        restore: { phase: cachePhase, status: 'bypass', reason: 'exact_artifact_reused', durationMs: 0 },
      });
    }
    process.exitCode = 0;
  } else {
    console.log(`[tauri-prebuild] rebuilding artifact: ${verification.reason}`);
    await cachedPhase('speech', 'speech sidecar', process.execPath, ['scripts/build-speech-local.mjs']);
    await cachedPhase('web', 'web build', 'npm', ['run', 'build']);
    phase('Tauri export', process.execPath, ['scripts/tauri-export.mjs']);
    const receipt = writeReleaseArtifactManifest(root, recipe);
    console.log(`[tauri-prebuild] verified artifact ${recipe.recipeSha256.slice(0, 16)} (${receipt.manifest.outputs.length} checksums)`);
  }
  cacheOutcome = 'PASS';
  if (env.O8_RELEASE_CACHE_PREBUILD_MARKER) {
    writeFileSync(env.O8_RELEASE_CACHE_PREBUILD_MARKER, `${Date.now()}\n`, { mode: 0o600 });
  }
} finally {
  if (ownedDataDir) rmSync(ownedDataDir, { recursive: true, force: true });
  if (ownsCacheRun) {
    try {
      const finalized = finalizeReleaseBuildCacheReceipt(cacheRoot, cacheRunId, {
        outcome: cacheOutcome,
        source: cacheSource,
        buildDurationMs: Date.now() - prebuildStartedAt,
      }, { projectRoot: root });
      console.log(`[release-cache] receipt ${finalized.receiptPath}`);
    } catch (error) {
      if (isReleaseBuildCacheSafetyError(error)) throw error;
      console.warn(`[release-cache] receipt unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
