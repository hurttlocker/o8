#!/usr/bin/env node
/**
 * Fetch the matching-arch `codebase-memory-mcp` static binary from the
 * upstream DeusData release and drop it into out/server/ so it ships as
 * a Tauri bundle resource alongside the Node MCP servers.
 *
 * Why fetch instead of commit:
 *   The binary is ~161 MB uncompressed × 4 architectures = >640 MB. That
 *   would balloon every clone and make Git LFS storage cost dominate. This
 *   script pulls only the binary that matches the build host so each
 *   installer carries exactly one architecture's binary.
 *
 * Idempotency:
 *   Writes a sentinel file `out/server/.codebase-memory-mcp.version` so
 *   reruns skip the download when the version + arch already match.
 *
 * Failure mode:
 *   Non-fatal — if the network fetch fails the script logs and exits 0
 *   without writing the binary. The Tauri sidecar treats a missing binary
 *   as "feature unavailable" rather than a startup blocker.
 *
 * Pin: bump CMM_VERSION to upgrade. checksums baked in below come from
 *      the upstream release `checksums.txt` for that tag.
 */
import { mkdirSync, existsSync, writeFileSync, readFileSync, statSync, chmodSync, createWriteStream, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const out = join(root, 'out', 'server');

// ── Version pin ────────────────────────────────────────────────────
// Bump this and the matching checksums entry to upgrade. See
// docs/codebase-memory-build.md for the upgrade procedure.
const CMM_VERSION = '0.6.0';
const CMM_REPO = 'DeusData/codebase-memory-mcp';

// SHA-256 from the upstream release `checksums.txt`. We pin these here
// so a tampered release artifact gets caught at build time even if the
// download succeeds.
const CHECKSUMS = {
  'codebase-memory-mcp-darwin-amd64.tar.gz': 'a4d09d97fe1f47e1a0a23309bc34d9937f74c61950bed3259f9576800cc78727',
  'codebase-memory-mcp-darwin-arm64.tar.gz': 'a1d3f8a4c353ab94ea8fe1fb60159758020f2f256c9652699a0bd6725189a439',
  'codebase-memory-mcp-linux-amd64.tar.gz': '0dfd70f73337219925f3ec6a572fe776dbbe1c4c8c6ab546ab214fe16e56a426',
  'codebase-memory-mcp-linux-arm64.tar.gz': 'f1fad27262fe7af4a356af128e43942355cb2189491079b6790ecc5ae3af069c',
  'codebase-memory-mcp-windows-amd64.zip': 'da3d7d7bd6f687b697145457ff9d113ecf6daffe173d236457a43223e89a5e9c',
};

// ── Platform detection ─────────────────────────────────────────────
function detectAsset() {
  const platform = process.platform; // 'darwin' | 'linux' | 'win32'
  const arch = process.arch;         // 'x64' | 'arm64'
  if (platform === 'darwin' && arch === 'x64')   return { name: 'codebase-memory-mcp-darwin-amd64.tar.gz', binary: 'codebase-memory-mcp', isZip: false };
  if (platform === 'darwin' && arch === 'arm64') return { name: 'codebase-memory-mcp-darwin-arm64.tar.gz', binary: 'codebase-memory-mcp', isZip: false };
  if (platform === 'linux'  && arch === 'x64')   return { name: 'codebase-memory-mcp-linux-amd64.tar.gz',  binary: 'codebase-memory-mcp', isZip: false };
  if (platform === 'linux'  && arch === 'arm64') return { name: 'codebase-memory-mcp-linux-arm64.tar.gz',  binary: 'codebase-memory-mcp', isZip: false };
  if (platform === 'win32'  && arch === 'x64')   return { name: 'codebase-memory-mcp-windows-amd64.zip',   binary: 'codebase-memory-mcp.exe', isZip: true };
  return null;
}

// ── Idempotency check ──────────────────────────────────────────────
function alreadyFetched(binaryPath, sentinelPath, expectedTag) {
  if (!existsSync(binaryPath) || !existsSync(sentinelPath)) return false;
  try {
    const tag = readFileSync(sentinelPath, 'utf-8').trim();
    return tag === expectedTag;
  } catch {
    return false;
  }
}

// ── Download with redirect support ─────────────────────────────────
async function download(url, dest) {
  // GitHub release URLs redirect to S3. Node 22+ follows redirects in
  // fetch() automatically.
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const stream = createWriteStream(dest);
  await pipeline(res.body, stream);
}

// ── SHA-256 verification ───────────────────────────────────────────
function sha256(filePath) {
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return hash.digest('hex');
}

// ── Extract (tar.gz or zip) ────────────────────────────────────────
function extract(archivePath, outDir, isZip) {
  if (isZip) {
    // unzip is preinstalled on macOS/Linux; on Windows the build runner
    // ships PowerShell which has Expand-Archive. Use unzip first.
    try {
      execSync(`unzip -o "${archivePath}" -d "${outDir}"`, { stdio: 'pipe' });
    } catch {
      execSync(`powershell -NoProfile -Command "Expand-Archive -Force -Path '${archivePath}' -DestinationPath '${outDir}'"`, { stdio: 'pipe' });
    }
  } else {
    execSync(`tar -xzf "${archivePath}" -C "${outDir}"`, { stdio: 'pipe' });
  }
}

// ── Main ───────────────────────────────────────────────────────────
async function main() {
  const asset = detectAsset();
  if (!asset) {
    console.warn(`[codebase-memory] unsupported host ${process.platform}/${process.arch} — skipping`);
    return;
  }

  const expectedSha = CHECKSUMS[asset.name];
  if (!expectedSha) {
    console.warn(`[codebase-memory] no checksum pinned for ${asset.name} — skipping`);
    return;
  }

  if (!existsSync(out)) mkdirSync(out, { recursive: true });

  const binaryPath = join(out, asset.binary);
  const sentinelPath = join(out, '.codebase-memory-mcp.version');
  const expectedTag = `${CMM_VERSION}-${asset.name}`;

  if (alreadyFetched(binaryPath, sentinelPath, expectedTag)) {
    console.log(`[codebase-memory] cached: ${asset.binary} v${CMM_VERSION}`);
    return;
  }

  const url = `https://github.com/${CMM_REPO}/releases/download/v${CMM_VERSION}/${asset.name}`;
  const tmpDir = join(tmpdir(), `o8-cmm-${process.pid}`);
  mkdirSync(tmpDir, { recursive: true });
  const archivePath = join(tmpDir, asset.name);

  try {
    console.log(`[codebase-memory] fetching ${asset.name} v${CMM_VERSION}…`);
    await download(url, archivePath);

    const actual = sha256(archivePath);
    if (actual !== expectedSha) {
      throw new Error(`sha256 mismatch: expected ${expectedSha}, got ${actual}`);
    }

    extract(archivePath, tmpDir, asset.isZip);

    const extractedBinary = join(tmpDir, asset.binary);
    if (!existsSync(extractedBinary)) {
      throw new Error(`binary not found in archive at ${extractedBinary}`);
    }

    // Move into out/server. Use cp for cross-fs safety.
    execSync(`cp "${extractedBinary}" "${binaryPath}"`, { stdio: 'pipe' });
    if (process.platform !== 'win32') chmodSync(binaryPath, 0o755);
    writeFileSync(sentinelPath, expectedTag);

    const sizeMB = (statSync(binaryPath).size / (1024 * 1024)).toFixed(1);
    console.log(`[codebase-memory] installed ${asset.binary} v${CMM_VERSION} (${sizeMB} MB)`);
  } catch (err) {
    // Non-fatal: warn and continue. The Tauri sidecar treats a missing
    // binary as "feature unavailable" — production builds without
    // network access should still succeed.
    console.warn(`[codebase-memory] fetch failed (non-fatal): ${err.message}`);
  } finally {
    // Best-effort tmp cleanup.
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => {
  // Catch-all guard so the script never blocks the wider prebuild.
  console.warn(`[codebase-memory] unexpected error (non-fatal): ${e.message}`);
});
