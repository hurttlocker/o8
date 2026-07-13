#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const BETTER_SQLITE3_NODE_ABI = '127';
const ADDON_NAME = 'better_sqlite3.node';

function readMachOArchitecture(filePath) {
  const header = readFileSync(filePath).subarray(0, 8);
  if (header.length < 8 || header.readUInt32LE(0) !== 0xfeedfacf) {
    throw new Error(`${filePath} is not a thin 64-bit Mach-O binary`);
  }

  const cpuType = header.readUInt32LE(4);
  if (cpuType === 0x01000007) return 'x64';
  if (cpuType === 0x0100000c) return 'arm64';
  throw new Error(`${filePath} has unsupported Mach-O CPU type 0x${cpuType.toString(16)}`);
}

function assertMachOArchitecture(filePath, expectedArch) {
  if (!existsSync(filePath)) {
    throw new Error(`missing ${expectedArch} native addon: ${filePath}`);
  }
  const actualArch = readMachOArchitecture(filePath);
  if (actualArch !== expectedArch) {
    throw new Error(`wrong architecture at ${filePath}: expected ${expectedArch}, found ${actualArch}`);
  }
  return { path: filePath, arch: actualArch };
}

export function betterSqlite3Asset(version) {
  const filename = `better-sqlite3-v${version}-node-v${BETTER_SQLITE3_NODE_ABI}-darwin-arm64.tar.gz`;
  return {
    filename,
    url: `https://github.com/WiseLibs/better-sqlite3/releases/download/v${version}/${filename}`,
  };
}

async function ensureCachedAsset(asset, cachePath) {
  if (existsSync(cachePath)) return 'cache';

  let response;
  try {
    response = await fetch(asset.url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new Error(`download failed and no cache exists at ${cachePath}: ${error.message}`);
  }
  if (!response.ok) {
    throw new Error(`download returned HTTP ${response.status} and no cache exists at ${cachePath}: ${asset.url}`);
  }

  mkdirSync(dirname(cachePath), { recursive: true });
  const partialPath = `${cachePath}.${process.pid}.tmp`;
  try {
    writeFileSync(partialPath, Buffer.from(await response.arrayBuffer()));
    renameSync(partialPath, cachePath);
  } finally {
    rmSync(partialPath, { force: true });
  }
  return 'download';
}

export async function prepareBetterSqlite3Bundle({ projectRoot, serverRoot, cacheRoot } = {}) {
  if (process.versions.modules !== BETTER_SQLITE3_NODE_ABI) {
    throw new Error(`better-sqlite3 export requires Node ABI ${BETTER_SQLITE3_NODE_ABI}; current ABI is ${process.versions.modules}`);
  }

  const resolvedProjectRoot = resolve(projectRoot ?? process.cwd());
  const resolvedServerRoot = resolve(serverRoot ?? join(resolvedProjectRoot, 'out', 'server'));
  const packageRoot = join(resolvedProjectRoot, 'node_modules', 'better-sqlite3');
  const packageJsonPath = join(packageRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    throw new Error(`better-sqlite3 is not installed at ${packageRoot}`);
  }

  const { version } = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const asset = betterSqlite3Asset(version);
  const resolvedCacheRoot = resolve(cacheRoot ?? join(homedir(), '.o8-build-cache', 'native'));
  const cachePath = join(resolvedCacheRoot, 'better-sqlite3', version, asset.filename);
  const cacheSource = await ensureCachedAsset(asset, cachePath);

  const moduleRoot = join(resolvedServerRoot, 'node_modules', 'better-sqlite3');
  const localAddon = join(moduleRoot, 'build', 'Release', ADDON_NAME);
  assertMachOArchitecture(localAddon, 'x64');

  const x64Dest = join(moduleRoot, 'prebuilds', 'darwin-x64', ADDON_NAME);
  mkdirSync(dirname(x64Dest), { recursive: true });
  copyFileSync(localAddon, x64Dest);

  const extractRoot = mkdtempSync(join(tmpdir(), 'o8-better-sqlite3-'));
  const extractedAddon = join(extractRoot, 'build', 'Release', ADDON_NAME);
  try {
    execFileSync('tar', ['-xzf', cachePath, '-C', extractRoot, `build/Release/${ADDON_NAME}`], { stdio: 'pipe' });
    assertMachOArchitecture(extractedAddon, 'arm64');
    const arm64Dest = join(moduleRoot, 'prebuilds', 'darwin-arm64', ADDON_NAME);
    mkdirSync(dirname(arm64Dest), { recursive: true });
    copyFileSync(extractedAddon, arm64Dest);
  } catch (error) {
    throw new Error(`failed to extract a valid arm64 addon from ${cachePath}: ${error.stderr?.toString().trim() || error.message}`);
  } finally {
    rmSync(extractRoot, { recursive: true, force: true });
  }

  return { assetUrl: asset.url, cachePath, cacheSource, version };
}

export function verifyNativeBundle(serverRoot, log = console.log) {
  const resolvedServerRoot = resolve(serverRoot);
  const required = [
    ['better-sqlite3 x64', join(resolvedServerRoot, 'node_modules', 'better-sqlite3', 'prebuilds', 'darwin-x64', ADDON_NAME), 'x64'],
    ['better-sqlite3 arm64', join(resolvedServerRoot, 'node_modules', 'better-sqlite3', 'prebuilds', 'darwin-arm64', ADDON_NAME), 'arm64'],
    ['node-pty arm64', join(resolvedServerRoot, 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'pty.node'), 'arm64'],
  ];

  const verified = [];
  for (const [label, filePath, expectedArch] of required) {
    try {
      verified.push(assertMachOArchitecture(filePath, expectedArch));
      log(`[native-gate] OK ${label}: ${filePath}`);
    } catch (error) {
      throw new Error(`[native-gate] FAILED ${label}: ${error.message}`);
    }
  }
  return verified;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [command, targetArg] = process.argv.slice(2);
  if (!targetArg || !['prepare', 'verify'].includes(command)) {
    console.error(`usage: node ${basename(import.meta.url)} prepare|verify <server-root>`);
    process.exit(1);
  }
  try {
    if (command === 'prepare') {
      const result = await prepareBetterSqlite3Bundle({ serverRoot: targetArg });
      console.log(`[native-export] asset ${result.assetUrl}`);
      console.log(`[native-export] ${result.cacheSource === 'cache' ? 'using cache' : 'cached download'} ${result.cachePath}`);
    } else {
      verifyNativeBundle(targetArg);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
