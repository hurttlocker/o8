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
const root = process.cwd();

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

const signature = readFileSync(APP_SIG, 'utf8').trim();
const pubDate = new Date().toISOString();
const downloadBase = `https://github.com/${REPO}/releases/download/${tag}`;

// Same signed binary works on x86_64 natively and aarch64 under Rosetta, so
// point both platforms at the same artifact until a native arm64 runner
// exists. Still signed with the same minisign key the installed app trusts.
const latestJson = {
  version,
  notes: `o8 ${tag}`,
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
    'release', 'upload', tag, ...uploadArgs,
    '--clobber',
    '-R', REPO,
  ], { stdio: 'inherit' });
} else {
  console.log(`[release] creating ${tag}`);
  execFileSync('gh', [
    'release', 'create', tag, ...uploadArgs,
    '--title', `o8 ${tag}`,
    '--notes', `o8 ${tag} — see installer assets.`,
    '-R', REPO,
  ], { stdio: 'inherit' });
}

console.log(`[release] published ${tag}`);
console.log(`[release] the installed o8.app will pick up the update on next launch`);
console.log(`[release] (or within 30 min via the UpdateBanner poll).`);
