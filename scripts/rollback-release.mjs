#!/usr/bin/env node
/**
 * Rollback the installed o8.app to the PREVIOUS signed release.
 *
 * When a bad version ships and the release-health kill-switch has stopped the
 * fleet from auto-updating INTO it, this brings a machine that already updated
 * back down to the prior good build. It:
 *
 *   1. Lists the two most recent GitHub releases (gh CLI).
 *   2. Downloads the PREVIOUS release's signed o8.app.tar.gz + .sig.
 *   3. Verifies the minisign signature against the updater pubkey embedded in
 *      src-tauri/tauri.conf.json (pure Node — Ed25519 over a Blake2b-512
 *      prehash, the exact scheme Tauri's updater uses). REFUSES to swap if the
 *      signature does not validate.
 *   4. Extracts + swaps /Applications/o8.app (the current app is moved aside to
 *      a timestamped backup, never deleted).
 *
 * Usage:
 *   node scripts/rollback-release.mjs            # do it
 *   node scripts/rollback-release.mjs --dry-run  # download + verify only
 *   node scripts/rollback-release.mjs --repo hurttlocker/o8-releases
 *   node scripts/rollback-release.mjs --app "/Applications/o8.app"
 *
 * Requires: gh (authenticated), tar, ditto (macOS).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync } from 'node:fs';
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Args ──
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
// Default to the public mirror — that's where updater artifacts (the signed
// .app.tar.gz + .sig) are published for anonymous download.
const REPO = argValue('--repo', 'hurttlocker/o8-releases');
const APP_PATH = argValue('--app', '/Applications/o8.app');
const root = process.cwd();

function log(msg) { console.log(`[rollback] ${msg}`); }
function fail(msg) { console.error(`[rollback] ERROR: ${msg}`); process.exit(1); }

// ── 1. Discover the two most recent releases ──
let tags;
try {
  const out = execFileSync(
    'gh',
    ['api', `repos/${REPO}/releases?per_page=10`, '--jq', '[.[] | select(.draft==false) | .tag_name]'],
    { encoding: 'utf8' },
  );
  tags = JSON.parse(out);
} catch (err) {
  fail(`could not list releases for ${REPO} via gh (${err?.message ?? err}). Is gh installed + authenticated?`);
}
if (!Array.isArray(tags) || tags.length < 2) {
  fail(`need at least two published releases on ${REPO} to roll back; found ${tags?.length ?? 0}.`);
}
const [currentTag, previousTag] = tags;
log(`current release:  ${currentTag}`);
log(`rolling back to:  ${previousTag}`);

// ── 2. Download the previous release's signed artifact + signature ──
const workDir = mkdtempSync(join(tmpdir(), 'o8-rollback-'));
log(`work dir: ${workDir}`);
try {
  execFileSync(
    'gh',
    ['release', 'download', previousTag, '-R', REPO,
      '-p', 'o8.app.tar.gz', '-p', 'o8.app.tar.gz.sig', '-D', workDir],
    { stdio: 'inherit' },
  );
} catch (err) {
  fail(`failed to download artifacts for ${previousTag} (${err?.message ?? err}).`);
}
const tarPath = join(workDir, 'o8.app.tar.gz');
const sigPath = join(workDir, 'o8.app.tar.gz.sig');
if (!existsSync(tarPath) || !existsSync(sigPath)) {
  fail(`downloaded artifacts missing (expected o8.app.tar.gz + .sig in ${workDir}).`);
}

// ── 3. Verify the minisign signature against the updater pubkey ──
function loadUpdaterPubkey() {
  const conf = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const wrapped = conf?.plugins?.updater?.pubkey;
  if (typeof wrapped !== 'string' || !wrapped) fail('no plugins.updater.pubkey in src-tauri/tauri.conf.json.');
  // Tauri stores the pubkey base64-wrapped around the standard minisign text.
  const std = Buffer.from(wrapped, 'base64').toString('utf8');
  const b64 = std.trim().split('\n')[1];
  const raw = Buffer.from(b64, 'base64'); // [2 alg][8 keyid][32 ed25519 key]
  return raw.subarray(10, 42);
}

function verifyMinisign(filePath, minisignSigPath, edPubRaw) {
  // Tauri's .sig is base64 of the standard minisign signature file.
  const std = Buffer.from(readFileSync(minisignSigPath, 'utf8').trim(), 'base64').toString('utf8');
  const sigB64 = std.trim().split('\n')[1];
  const sigRaw = Buffer.from(sigB64, 'base64'); // [2 alg][8 keyid][64 sig]
  const alg = sigRaw.subarray(0, 2).toString('latin1');
  const edSig = sigRaw.subarray(10, 74);

  // Ed25519 raw pubkey -> SPKI DER so Node's crypto can consume it.
  const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), edPubRaw]);
  const keyObj = createPublicKey({ key: der, format: 'der', type: 'spki' });

  const file = readFileSync(filePath);
  // 'ED' = prehashed (Blake2b-512 of the file); 'Ed' = legacy (raw file).
  const message = alg === 'ED' ? createHash('blake2b512').update(file).digest() : file;
  return edVerify(null, message, keyObj, edSig);
}

let verified = false;
try {
  verified = verifyMinisign(tarPath, sigPath, loadUpdaterPubkey());
} catch (err) {
  fail(`signature verification threw (${err?.message ?? err}). Refusing to swap.`);
}
if (!verified) {
  fail(`signature verification FAILED for ${previousTag}. Refusing to swap the app.`);
}
log(`signature verified OK for ${previousTag} against the updater pubkey.`);

if (dryRun) {
  log('DRY RUN — download + verification succeeded. No files were swapped.');
  log(`Verified artifact: ${tarPath}`);
  process.exit(0);
}

// ── 4. Extract + swap /Applications/o8.app ──
const extractDir = join(workDir, 'extracted');
try {
  execFileSync('mkdir', ['-p', extractDir]);
  // COPYFILE_DISABLE=1 keeps macOS tar from materializing AppleDouble ._ files.
  execFileSync('tar', ['-xzf', tarPath, '-C', extractDir], {
    stdio: 'inherit',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
} catch (err) {
  fail(`failed to extract ${tarPath} (${err?.message ?? err}).`);
}
const extractedApp = join(extractDir, 'o8.app');
if (!existsSync(extractedApp)) {
  fail(`extracted bundle missing o8.app (looked in ${extractDir}).`);
}

// Move the current app aside (never delete) so a bad rollback is recoverable.
if (existsSync(APP_PATH)) {
  const backup = `${APP_PATH}.rollback-backup-${Date.now()}`;
  try {
    renameSync(APP_PATH, backup);
    log(`moved current app aside → ${backup}`);
  } catch (err) {
    fail(`could not move ${APP_PATH} aside (${err?.message ?? err}). Do you have permission?`);
  }
}

try {
  // ditto is the macOS-blessed bundle copy (preserves resource forks + perms).
  execFileSync('ditto', [extractedApp, APP_PATH], { stdio: 'inherit' });
} catch (err) {
  fail(`failed to install rolled-back app to ${APP_PATH} (${err?.message ?? err}).`);
}

log(`DONE — ${APP_PATH} is now ${previousTag}. Quit + relaunch o8 if it is running.`);
log('The previous app bundle is kept as a .rollback-backup-* sibling; delete it once you are happy.');
