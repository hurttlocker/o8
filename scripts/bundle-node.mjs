#!/usr/bin/env node
/**
 * Downloads and extracts the Node.js binary for the target platform.
 * The binary is placed in out/node/ so Tauri bundles it as a resource.
 *
 * Usage:
 *   node scripts/bundle-node.mjs                    # current platform
 *   node scripts/bundle-node.mjs --arch aarch64     # Apple Silicon
 *   node scripts/bundle-node.mjs --arch x64         # Intel
 */
import { mkdirSync, existsSync, chmodSync, createWriteStream, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = join(root, 'out', 'server', 'node');

// REMOVED: Node.js is now a prerequisite, not bundled.
// Users must have Node.js installed (any recent version).
// This script is kept for reference but no longer called by tauri:prebuild.
console.log('⏭️  Node.js bundling disabled — prerequisite model');
console.log('   Users need Node.js installed: https://nodejs.org');
process.exit(0);

// Parse args
const args = process.argv.slice(2);
const archArg = args.find((a, i) => args[i - 1] === '--arch') || '';
const platform = process.platform; // darwin, linux, win32

function getArch() {
  if (archArg === 'aarch64' || archArg === 'arm64') return 'arm64';
  if (archArg === 'x64' || archArg === 'x86_64') return 'x64';
  return process.arch; // auto-detect
}

const arch = getArch();
const nodeArch = arch === 'arm64' ? 'arm64' : 'x64';
const nodePlatform = platform === 'win32' ? 'win' : platform;
const ext = platform === 'win32' ? 'zip' : 'tar.gz';
const nodeDir = `node-v${NODE_VERSION}-${nodePlatform}-${nodeArch}`;
const url = `https://nodejs.org/dist/v${NODE_VERSION}/${nodeDir}.${ext}`;

console.log(`📦 Bundling Node.js v${NODE_VERSION} (${nodePlatform}-${nodeArch})`);
console.log(`   URL: ${url}`);

// Create output directory
mkdirSync(outDir, { recursive: true });

const nodeBin = join(outDir, platform === 'win32' ? 'node.exe' : 'node');

if (existsSync(nodeBin)) {
  console.log(`✅ Node binary already exists at ${nodeBin}`);
  process.exit(0);
}

// Download
const tarball = join(outDir, `node.${ext}`);
console.log('⬇️  Downloading...');

const res = await fetch(url);
if (!res.ok) {
  console.error(`❌ Failed to download: ${res.status} ${res.statusText}`);
  process.exit(1);
}

await pipeline(
  Readable.fromWeb(res.body),
  createWriteStream(tarball),
);
console.log('✅ Downloaded');

// Extract — we only need the `node` binary, not the full tarball
console.log('📂 Extracting node binary...');

if (platform === 'win32') {
  execSync(`powershell -Command "Expand-Archive -Path '${tarball}' -DestinationPath '${outDir}' -Force"`, { stdio: 'inherit' });
  const extracted = join(outDir, nodeDir, 'node.exe');
  execSync(`mv "${extracted}" "${nodeBin}"`, { stdio: 'inherit' });
} else {
  // Extract full tarball then move just the node binary
  execSync(`tar -xzf "${tarball}" -C "${outDir}"`, { stdio: 'inherit' });
  const extracted = join(outDir, nodeDir, 'bin', 'node');
  execSync(`mv "${extracted}" "${nodeBin}"`, { stdio: 'inherit' });
}

// Cleanup tarball
unlinkSync(tarball);

// Remove extracted directory leftovers
try {
  execSync(`rm -rf "${join(outDir, nodeDir)}"`, { stdio: 'ignore' });
} catch { /* ok */ }

// Ensure executable
chmodSync(nodeBin, 0o755);

// Verify
const version = execSync(`"${nodeBin}" --version`, { encoding: 'utf-8' }).trim();
const size = execSync(`du -sh "${nodeBin}"`, { encoding: 'utf-8' }).trim().split('\t')[0];
console.log(`\n✅ Bundled Node.js ${version} (${size}) → ${nodeBin}`);
