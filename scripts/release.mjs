#!/usr/bin/env node
/**
 * Local release script — skips GitHub Actions entirely.
 *
 * The normal Tauri release flow uses tauri-action on macos-latest runners.
 * That works fine when GitHub billing is healthy, but for a "ship to myself"
 * dev prod mode loop it's slower (~6 min CI) and requires paid minutes.
 *
 * This script does the same thing from a local build:
 *   1. Reads the current package.json version (already synced across all
 *      manifests via scripts/sync-version.mjs)
 *   2. Locates the cargo tauri build artifacts
 *   3. Generates the tauri-updater latest.json with the signature + URL
 *   4. Creates (or replaces) the GitHub release and uploads everything
 *
 * Usage:
 *   TAURI_SIGNING_PRIVATE_KEY=$(cat ~/.tauri/cortex-ide.key) npm run tauri:build
 *   node scripts/release.mjs
 *
 * Or via the combined script:
 *   npm run ship
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const REPO = 'hurttlocker/cortex-ide';
const PUBLIC_MIRROR = 'hurttlocker/o8';
const root = process.cwd();

// Node ABI guard: better-sqlite3 is compiled against the build-machine's Node
// ABI (NODE_MODULE_VERSION). A v0.1.119 ship built on Node 25 produced an
// ABI 141 binary that crashed on Node 22 users with "NODE_MODULE_VERSION 141
// vs 127" — see #1015. The runtime app requires Node ≥22, so the build must
// also be on Node 22 to keep ABIs aligned.
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor !== 22) {
  console.error(`[release] FATAL: builds must run on Node 22 LTS (current: ${process.version})`);
  console.error(`[release] Run \`nvm use\` (reads .nvmrc) then retry npm run ship.`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = `v${version}`;

const BUNDLE = join(root, 'src-tauri/target/release/bundle');
const DMG = join(BUNDLE, 'dmg', `o8_${version}_x64.dmg`);
const APP_TAR = join(BUNDLE, 'macos', 'o8.app.tar.gz');
const APP_SIG = join(BUNDLE, 'macos', 'o8.app.tar.gz.sig');

for (const path of [DMG, APP_TAR, APP_SIG]) {
  if (!existsSync(path)) {
    console.error(`[release] missing artifact: ${path}`);
    console.error(`[release] Run this first:`);
    console.error(`[release]   TAURI_SIGNING_PRIVATE_KEY=$(cat ~/.tauri/cortex-ide.key) cargo tauri build`);
    process.exit(1);
  }
}

let gateWarnFailed = false;
try {
  execFileSync('node', ['scripts/preship-webview-gate.mjs', '--mode=authoritative', APP_TAR], { stdio: 'inherit' });
} catch {
  // #1163: WARN-ONLY. The gate's authoritative run records its own PASS/FAIL
  // audit row before returning; here a non-zero exit (including a child-app
  // panic that false-blocks a healthy build) is logged and stamped into the
  // published release notes for an honest trail — but it does NOT abort the
  // publish. Restore the hard block with O8_GATE_STRICT=1 once the gate no
  // longer panics its own child (the #1163 robustness fix).
  if (process.env.O8_GATE_STRICT === '1') {
    console.error('[release] pre-ship boot gate FAILED (O8_GATE_STRICT) — refusing to publish.');
    process.exit(1);
  }
  gateWarnFailed = true;
  console.warn('[release] WARNING: pre-ship boot gate failed (warn-only, #1163). Publishing anyway. Set O8_GATE_STRICT=1 to hard-block.');
}

const signature = readFileSync(APP_SIG, 'utf8').trim();
const pubDate = new Date().toISOString();
// Point latest.json download URLs at the PUBLIC MIRROR so the Tauri updater
// can fetch artifacts anonymously. The private repo (REPO) returns 404 for
// anonymous download requests even when the release is published.
const downloadBase = `https://github.com/${PUBLIC_MIRROR}/releases/download/${tag}`;
const gateReleaseNotePath = join(BUNDLE, 'macos', 'preship-webview-gate-release-note.txt');
const gateReleaseNote = existsSync(gateReleaseNotePath)
  ? readFileSync(gateReleaseNotePath, 'utf8').trim()
  : '';
const warnStamp = gateWarnFailed
  ? '\n\ngate:warn-failed — pre-ship boot gate did not pass; shipped warn-only per #1163.'
  : '';
const releaseNotes = (gateReleaseNote
  ? `o8 ${tag} — see installer assets.\n\n${gateReleaseNote}`
  : `o8 ${tag} — see installer assets.`) + warnStamp;
const latestNotes = gateReleaseNote ? `o8 ${tag} — ${gateReleaseNote}` : `o8 ${tag}`;

// Same signed binary works on x86_64 natively and aarch64 under Rosetta, so
// point both platforms at the same artifact until a native arm64 runner
// exists. Still signed with the same minisign key the installed app trusts.
const latestJson = {
  version,
  notes: latestNotes,
  pub_date: pubDate,
  platforms: {
    'darwin-x86_64': {
      signature,
      url: `${downloadBase}/o8.app.tar.gz`,
    },
    'darwin-aarch64': {
      signature,
      url: `${downloadBase}/o8.app.tar.gz`,
    },
  },
};

const latestJsonPath = join(BUNDLE, 'macos', 'latest.json');
writeFileSync(latestJsonPath, JSON.stringify(latestJson, null, 2));
console.log(`[release] wrote ${latestJsonPath}`);

try {
  execFileSync('git', ['ls-remote', '--exit-code', 'origin', `refs/tags/${tag}`], { stdio: 'pipe' });
  console.log(`[release] tag ${tag} present on origin`);
} catch {
  console.error(`[release] tag ${tag} is not on origin. run: git push --follow-tags`);
  process.exit(1);
}

let releaseExists = false;
try {
  execFileSync('gh', ['release', 'view', tag, '-R', REPO], { stdio: 'pipe' });
  releaseExists = true;
} catch {}

const uploadArgs = [DMG, APP_TAR, APP_SIG, latestJsonPath];

if (releaseExists) {
  console.log(`[release] ${tag} already exists — replacing assets`);
  execFileSync('gh', [
    'release', 'edit', tag,
    '--title', `o8 ${tag}`,
    '--notes', releaseNotes,
    '-R', REPO,
  ], { stdio: 'inherit' });
  execFileSync('gh', [
    'release', 'upload', tag, ...uploadArgs,
    '--clobber',
    '-R', REPO,
  ], { stdio: 'inherit' });
} else {
  console.log(`[release] creating ${tag}`);
  execFileSync('gh', [
    'release', 'create', tag, ...uploadArgs,
    '--title', `o8 ${tag}`,
    '--notes', releaseNotes,
    '-R', REPO,
  ], { stdio: 'inherit' });
}

console.log(`[release] published ${tag}`);

// Mirror artifacts to the public repo so the Tauri updater can fetch
// latest.json + the .app.tar.gz anonymously. The private REPO is the source
// of truth for code + full release notes; PUBLIC_MIRROR only carries the
// updater payload. Failures here are logged but non-fatal — the private
// publish above already succeeded.
const mirrorNotes = gateReleaseNote
  ? `Auto-update artifacts for o8 ${tag}. See https://github.com/${REPO}/releases/tag/${tag} for details.\n\n${gateReleaseNote}`
  : `Auto-update artifacts for o8 ${tag}. See https://github.com/${REPO}/releases/tag/${tag} for details.`;

try {
  let mirrorExists = false;
  try {
    execFileSync('gh', ['release', 'view', tag, '-R', PUBLIC_MIRROR], { stdio: 'pipe' });
    mirrorExists = true;
  } catch {}

  if (mirrorExists) {
    console.log(`[release-mirror] ${tag} already exists on ${PUBLIC_MIRROR} — replacing assets`);
    execFileSync('gh', [
      'release', 'edit', tag,
      '--title', `o8 ${tag}`,
      '--notes', mirrorNotes,
      '-R', PUBLIC_MIRROR,
    ], { stdio: 'inherit' });
    execFileSync('gh', [
      'release', 'upload', tag, ...uploadArgs,
      '--clobber',
      '-R', PUBLIC_MIRROR,
    ], { stdio: 'inherit' });
  } else {
    console.log(`[release-mirror] creating ${tag} on ${PUBLIC_MIRROR}`);
    execFileSync('gh', [
      'release', 'create', tag, ...uploadArgs,
      '--title', `o8 ${tag}`,
      '--notes', mirrorNotes,
      '-R', PUBLIC_MIRROR,
    ], { stdio: 'inherit' });
  }

  console.log(`[release-mirror] mirrored ${tag} to ${PUBLIC_MIRROR}`);
} catch (err) {
  console.error(`[release-mirror] failed to mirror ${tag} to ${PUBLIC_MIRROR}:`, err?.message ?? err);
  console.error(`[release-mirror] private publish above is unaffected — auto-update will not pick up this version until the mirror succeeds`);
}

console.log(`[release] the installed o8.app will pick up the update on next launch`);
console.log(`[release] (or within 30 min via the UpdateBanner poll).`);
