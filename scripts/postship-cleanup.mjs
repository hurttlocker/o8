#!/usr/bin/env node
/** Reclaim generated native-release outputs after publication finishes. */
import { lstat, readFile, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const POSTSHIP_GENERATED_DIRS = [
  '.next',
  'src-tauri/target',
  'src-tauri/sidecars/speech-local/.build',
];

// `out` is the verified release artifact, not disposable scratch space. Its
// provenance manifest and checksummed outputs let the next exact-match
// prebuild reuse the web and speech artifacts instead of rebuilding them.
export const POSTSHIP_PRESERVED_DIRS = ['out'];

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function assertO8RepoRoot(repoRoot) {
  const packagePath = path.join(repoRoot, 'package.json');
  const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
  if (manifest?.name !== 'o8') {
    throw new Error(`refusing cleanup outside the o8 repo: ${packagePath}`);
  }
}

async function assertGeneratedTreeHasNoLinks(target, relativePath) {
  const pending = [target];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      const metadata = await lstat(candidate);
      if (entry.isSymbolicLink() || metadata.isSymbolicLink()) {
        throw new Error(`linked entry inside ${relativePath}: ${path.relative(target, candidate)}`);
      }
      if (metadata.isDirectory()) pending.push(candidate);
    }
  }
}

export async function cleanupPostshipOutputs(repoRoot = process.cwd()) {
  const root = await realpath(path.resolve(repoRoot));
  await assertO8RepoRoot(root);
  const result = { removed: [], skipped: [], refused: [] };

  for (const relativePath of POSTSHIP_GENERATED_DIRS) {
    const target = path.resolve(root, relativePath);
    if (!isInside(root, target)) {
      result.refused.push({ path: relativePath, reason: 'outside repo root' });
      break;
    }

    let metadata;
    try {
      metadata = await lstat(target);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        result.skipped.push(relativePath);
        continue;
      }
      result.refused.push({ path: relativePath, reason: error instanceof Error ? error.message : String(error) });
      break;
    }

    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      result.refused.push({ path: relativePath, reason: 'target is not a real directory' });
      break;
    }

    try {
      await assertGeneratedTreeHasNoLinks(target, relativePath);
      await rm(target, { recursive: true, force: false, maxRetries: 0 });
      result.removed.push(relativePath);
    } catch (error) {
      result.refused.push({ path: relativePath, reason: error instanceof Error ? error.message : String(error) });
      break;
    }
  }

  return result;
}

async function main() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const result = await cleanupPostshipOutputs();
    console.log(
      `[postship-cleanup] removed=${result.removed.length} skipped=${result.skipped.length} refused=${result.refused.length}`,
    );
    for (const refusal of result.refused) {
      console.warn(`[postship-cleanup] refused ${refusal.path}: ${refusal.reason}`);
    }
    if (result.refused.length > 0 && !bestEffort) process.exitCode = 1;
  } catch (error) {
    console.warn(`[postship-cleanup] ${error instanceof Error ? error.message : String(error)}`);
    if (!bestEffort) process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
