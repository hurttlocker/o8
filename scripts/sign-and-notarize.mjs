#!/usr/bin/env node
/**
 * Post-bundle sign-and-notarize pass.
 *
 * Tauri's `cargo tauri build` signs the .app shell with our Developer ID
 * cert, but its codesign --deep walk skips Node native modules under
 * Resources/server/node_modules. Apple's notary service then rejects the
 * submission ("binary is not signed", "hardened runtime not enabled").
 *
 * This script runs after `cargo tauri build` to:
 *   1. Find every Mach-O binary inside Resources/server/node_modules
 *      (.node files, .dylib, named executables like spawn-helper)
 *   2. Sign each with hardened runtime + secure timestamp + Developer ID
 *   3. Re-seal the .app shell with --force --deep so the outer signature
 *      covers the now-signed nested binaries
 *   4. Submit the .app to Apple's notarytool, wait, and staple
 *   5. Re-package as .app.tar.gz, sign with the Tauri minisign key, and
 *      rebuild the .dmg so the updater + dmg both ship the stapled app
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const REQUIRED = ['APPLE_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID'];
for (const key of REQUIRED) {
  if (!process.env[key]) {
    console.error(`[sign-and-notarize] missing env var: ${key}`);
    console.error(`[sign-and-notarize] expected in ~/.zshenv`);
    process.exit(1);
  }
}

const root = process.cwd();
const pkgJson = JSON.parse(execFileSync('cat', [join(root, 'package.json')], { encoding: 'utf8' }));
const version = pkgJson.version;
const BUNDLE = join(root, 'src-tauri/target/release/bundle');
const APP = join(BUNDLE, 'macos/o8.app');
const TAR = join(BUNDLE, 'macos/o8.app.tar.gz');
const TAR_SIG = join(BUNDLE, 'macos/o8.app.tar.gz.sig');
const DMG = join(BUNDLE, `dmg/o8_${version}_x64.dmg`);
const ENTITLEMENTS = join(root, 'src-tauri/entitlements.plist');
const SIGNING_KEY = `${process.env.HOME}/.tauri/cortex-ide.key`;

if (!existsSync(APP)) {
  console.error(`[sign-and-notarize] missing .app: ${APP}`);
  console.error(`[sign-and-notarize] run cargo tauri build first`);
  process.exit(1);
}

function walk(dir, predicate, results = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      walk(full, predicate, results);
    } else if (stat.isFile() && predicate(name, full)) {
      results.push(full);
    }
  }
  return results;
}

console.log('[sign-and-notarize] finding nested Mach-O binaries...');
const nodeModulesRoot = join(APP, 'Contents/Resources/server/node_modules');
const candidates = walk(nodeModulesRoot, (name) => (
  name.endsWith('.node')
  || name.endsWith('.dylib')
  || name === 'spawn-helper'
));

const machO = [];
for (const f of candidates) {
  try {
    const out = execFileSync('file', [f], { encoding: 'utf8' });
    if (out.includes('Mach-O')) machO.push(f);
  } catch {
    // skip files that can't be examined
  }
}
console.log(`[sign-and-notarize] signing ${machO.length} nested binaries`);

for (const f of machO) {
  execFileSync('codesign', [
    '--force',
    '--options', 'runtime',
    '--timestamp',
    '--sign', process.env.APPLE_SIGNING_IDENTITY,
    f,
  ], { stdio: 'inherit' });
}

console.log('[sign-and-notarize] re-sealing .app shell with --deep');
execFileSync('codesign', [
  '--force',
  '--deep',
  '--options', 'runtime',
  '--timestamp',
  '--sign', process.env.APPLE_SIGNING_IDENTITY,
  '--entitlements', ENTITLEMENTS,
  APP,
], { stdio: 'inherit' });

console.log('[sign-and-notarize] verifying signature');
execFileSync('codesign', ['--verify', '--strict', '--verbose=2', APP], { stdio: 'inherit' });

const ZIP = '/tmp/o8-notarize.zip';
if (existsSync(ZIP)) rmSync(ZIP);
console.log('[sign-and-notarize] zipping for notarization');
execFileSync('ditto', ['-c', '-k', '--keepParent', APP, ZIP], { stdio: 'inherit' });

console.log('[sign-and-notarize] submitting to Apple notary (5-15 min)');
execFileSync('xcrun', [
  'notarytool', 'submit', ZIP,
  '--apple-id', process.env.APPLE_ID,
  '--team-id', process.env.APPLE_TEAM_ID,
  '--password', process.env.APPLE_PASSWORD,
  '--wait',
], { stdio: 'inherit' });

console.log('[sign-and-notarize] stapling notarization ticket');
execFileSync('xcrun', ['stapler', 'staple', APP], { stdio: 'inherit' });

console.log('[sign-and-notarize] repackaging .app.tar.gz');
if (existsSync(TAR)) rmSync(TAR);
if (existsSync(TAR_SIG)) rmSync(TAR_SIG);
execFileSync('tar', ['czf', TAR, '-C', join(BUNDLE, 'macos'), 'o8.app'], { stdio: 'inherit' });

console.log('[sign-and-notarize] minisign-signing the new tar.gz');
// `cargo tauri signer sign` rejects `--password ""`; pass an empty
// password via env var instead. The minisign key was generated without
// a password so this is intentional.
execFileSync('cargo', [
  'tauri', 'signer', 'sign',
  '--private-key-path', SIGNING_KEY,
  TAR,
], {
  stdio: 'inherit',
  env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: '', TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' },
});

console.log('[sign-and-notarize] rebuilding DMG with stapled app');
if (existsSync(DMG)) rmSync(DMG);
execFileSync('hdiutil', [
  'create',
  '-volname', `o8 ${version}`,
  '-srcfolder', APP,
  '-ov',
  '-format', 'UDZO',
  DMG,
], { stdio: 'inherit' });

console.log('[sign-and-notarize] signing DMG');
execFileSync('codesign', [
  '--force',
  '--sign', process.env.APPLE_SIGNING_IDENTITY,
  '--timestamp',
  DMG,
], { stdio: 'inherit' });

console.log('[sign-and-notarize] done. now run scripts/release.mjs to publish');
