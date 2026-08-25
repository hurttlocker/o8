#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectReleaseArtifactRecipe,
  verifyReleaseArtifactManifest,
  writeReleaseArtifactManifest,
} from './lib/release-artifacts.mjs';

const root = process.cwd();
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const ownedDataDir = !process.env.O8_DATA_DIR || !process.env.CORTEX_IDE_DATA_DIR
  ? mkdtempSync(join(tmpdir(), 'o8-tauri-build-data-'))
  : null;
const env = {
  ...process.env,
  O8_DATA_DIR: process.env.O8_DATA_DIR || ownedDataDir,
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR || ownedDataDir,
};

function phase(label, command, args) {
  const started = Date.now();
  console.log(`[tauri-prebuild] ${label} started`);
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit ${result.status ?? 'unknown'} after ${seconds}s`);
  console.log(`[tauri-prebuild] ${label} completed in ${seconds}s`);
}

try {
  phase('stale-build preflight', process.execPath, ['scripts/preship-cleanup.mjs']);
  const recipe = collectReleaseArtifactRecipe(root, version);
  const verification = verifyReleaseArtifactManifest(root, recipe);
  if (verification.reusable) {
    console.log(`[tauri-prebuild] reused verified artifact ${recipe.recipeSha256.slice(0, 16)} (${verification.manifest.outputs.length} checksums)`);
    process.exitCode = 0;
  } else {
    console.log(`[tauri-prebuild] rebuilding artifact: ${verification.reason}`);
    phase('speech sidecar', process.execPath, ['scripts/build-speech-local.mjs']);
    phase('web build', 'npm', ['run', 'build']);
    phase('Tauri export', process.execPath, ['scripts/tauri-export.mjs']);
    const receipt = writeReleaseArtifactManifest(root, recipe);
    console.log(`[tauri-prebuild] verified artifact ${recipe.recipeSha256.slice(0, 16)} (${receipt.manifest.outputs.length} checksums)`);
  }
} finally {
  if (ownedDataDir) rmSync(ownedDataDir, { recursive: true, force: true });
}
