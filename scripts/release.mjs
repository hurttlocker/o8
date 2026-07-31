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
import { join, resolve } from 'node:path';
import { buildManifest, readPublished, releaseRange, resolveNewFixes } from './lib/fixed-reports.mjs';
import { publishFixed } from './publish-fixed.mjs';
import { syncReports } from './sync-reports.mjs';
import { verifyNativeBundle } from './native-bundle.mjs';

const REPO = 'hurttlocker/o8';
const PUBLIC_MIRROR = 'hurttlocker/o8-releases';
// The real source repo. EMPTY until hurttlocker/o8 is public — see composeReleaseAnnouncement().
// Q 2026-07-31: "they need to point to the real repo because it will be public soon."
const SOURCE_REPO = process.env.O8_SOURCE_REPO || '';
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister';
const root = process.cwd();

function runNativeGate(serverRoot) {
  verifyNativeBundle(serverRoot);
  console.log('[release] native addon ABI + architecture gate passed');
}

if (process.argv[2] === '--verify-native-bundle') {
  const target = process.argv[3];
  if (!target) {
    console.error('[release] usage: node scripts/release.mjs --verify-native-bundle <server-root>');
    process.exit(1);
  }
  try {
    runNativeGate(resolve(target));
    process.exit(0);
  } catch (error) {
    console.error(`[release] FATAL: ${error.message}`);
    process.exit(1);
  }
}


// The authoring toolchain stays pinned to Node 22 via package.json + .nvmrc.
// Runtime ABI compatibility is independent of this guard: tauri-export now
// downloads and gates the Node 22 + 24 better-sqlite3 prebuilds explicitly.
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor !== 22) {
  console.error(`[release] FATAL: builds must run on Node 22 LTS (current: ${process.version})`);
  console.error(`[release] Run \`nvm use\` (reads .nvmrc) then retry npm run ship.`);
  process.exit(1);
}

// `npm run ship` detaches stale DMGs before this script. Garbage-collect their
// LaunchServices claims before publishing so dead o8:// handlers do not accrue.
if (process.platform === 'darwin') {
  try {
    execFileSync(LSREGISTER, ['-gc'], { stdio: 'ignore' });
    console.log('[release] garbage-collected stale LaunchServices registrations');
  } catch (error) {
    console.warn(`[release] LaunchServices garbage collection skipped: ${error?.message ?? error}`);
  }
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = `v${version}`;

// Manual community-announce path: preview prints, announce posts. For backfill
// (a release that shipped before the webhook existed) or a re-run after a
// Discord hiccup. The full ship flow calls announceRelease() automatically.
if (process.argv[2] === '--announce-preview' || process.argv[2] === '--announce') {
  console.log(composeReleaseAnnouncement());
  if (process.argv[2] === '--announce') {
    await announceRelease();
  }
  process.exit(0);
}

try {
  const headTag = execFileSync('git', ['describe', '--tags', '--exact-match', 'HEAD'], { encoding: 'utf8' }).trim();
  if (headTag !== tag) {
    console.warn(`[release] WARNING: HEAD is ${headTag}, not ${tag}; fixed-report receipts will scan ${releaseRange(tag)}.`);
  }
} catch {
  console.warn(`[release] WARNING: HEAD is not ${tag}; fixed-report receipts will scan ${releaseRange(tag)}.`);
}

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

const PACKAGED_SERVER = join(BUNDLE, 'macos', 'o8.app', 'Contents', 'Resources', 'server');
try {
  runNativeGate(PACKAGED_SERVER);
} catch (error) {
  console.error(`[release] FATAL: ${error.message}`);
  console.error('[release] Refusing to publish without Node 22 + 24, x64 + arm64 prebuilds for both native addons.');
  process.exit(1);
}

// #1163: OPT-IN. The gate launches a disposable 2nd o8.app copy from /tmp that
// intermittently PANICS (resource-dir / wry event loop) → macOS crash-report
// dialogs at the operator + false-blocked ships. Disabled by default until it's
// redesigned to drive the running app / a headless WKWebView harness. The
// author-time #1160 ESLint guard + directive cover the 0.1.252 class meanwhile.
// Re-enable with O8_PRESHIP_GATE_ENABLED=1; O8_GATE_STRICT=1 additionally hard-blocks.
let gateWarnFailed = false;
if (process.env.O8_PRESHIP_GATE_ENABLED === '1') {
  try {
    execFileSync('node', ['scripts/preship-webview-gate.mjs', '--mode=authoritative', APP_TAR], { stdio: 'inherit' });
  } catch {
    if (process.env.O8_GATE_STRICT === '1') {
      console.error('[release] pre-ship boot gate FAILED (O8_GATE_STRICT) — refusing to publish.');
      process.exit(1);
    }
    gateWarnFailed = true;
    console.warn('[release] WARNING: pre-ship boot gate failed (warn-only, #1163). Publishing anyway.');
  }
} else {
  console.log('[release] pre-ship boot gate skipped (opt-in via O8_PRESHIP_GATE_ENABLED=1; disabled by default — spawns a crashing GUI child, #1163).');
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

// fixed.json — the receipt manifest, shipped next to latest.json.
//
// The reporter's own app downloads this (public, anonymous, same URL pattern the
// updater already uses — no new infrastructure, no cost) and joins it against
// its LOCAL ledger to tell them their bug is fixed. It never uploads anything.
//
// CUMULATIVE on purpose: a per-release list would lose a fix for anyone who skips
// versions. Contains no reporter handles — the app only needs "was MY report
// fixed, and in which version".
// Mirror the intake channel into the local ledger first — a user's report was
// recorded on THEIR machine, not ours, so without this every fix we ship for
// someone else's bug resolves to "unknown id" and never reaches fixed.json.
try {
  const { fresh } = await syncReports();
  if (fresh.length > 0) console.log(`[release] imported ${fresh.length} report(s) from the intake channel`);
} catch (err) {
  console.warn(`[release] ⚠ intake-channel sync failed: ${err?.message ?? err}`);
  console.warn('[release]   only self-filed reports will resolve — fixes for other people\'s bugs will be skipped.');
}
const { entries: pendingFixes, missing: unknownFixes } = resolveNewFixes(releaseRange(tag), version);
const fixedManifest = buildManifest([...readPublished(), ...pendingFixes], pubDate);
const fixedJsonPath = join(BUNDLE, 'macos', 'fixed.json');
writeFileSync(fixedJsonPath, JSON.stringify(fixedManifest, null, 2));
console.log(`[release] wrote ${fixedJsonPath} (${fixedManifest.fixed.length} fixed report${fixedManifest.fixed.length === 1 ? '' : 's'}, ${pendingFixes.length} new this release)`);
if (unknownFixes.length > 0) {
  console.warn(`[release] ⚠ ${unknownFixes.length} Fixes-Report trailer(s) name an id with no ledger entry — those reporters will NOT get a receipt:`);
  for (const { id, commit } of unknownFixes) console.warn(`[release]   ${id} (${commit.sha})`);
}

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

const uploadArgs = [DMG, APP_TAR, APP_SIG, latestJsonPath, fixedJsonPath];

// #1486 — an existing release for the CURRENT version almost always means the
// operator forgot `npm version patch`: silently replacing the published
// assets under the same tag re-signs history and updaters never see a new
// build (the 2026-07-08 #1499 incident). Refuse unless explicitly overridden.
if (releaseExists && process.env.O8_RELEASE_CLOBBER !== '1') {
  console.error(`[release] REFUSING: ${tag} is already published. Did you forget to bump?`);
  console.error('[release]   npm version patch && git push origin main --follow-tags && npm run ship');
  console.error('[release] To deliberately replace the existing release assets in place:');
  console.error('[release]   O8_RELEASE_CLOBBER=1 npm run ship');
  process.exit(1);
}

if (releaseExists) {
  console.log(`[release] ${tag} already exists — replacing assets (O8_RELEASE_CLOBBER=1)`);
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

  // Announce the fixes ONLY now — the mirror is what makes v${version} real, and
  // "fixed in v0.1.592" is a lie until an operator can actually install it.
  // Non-fatal: a Discord hiccup must never fail a shipped release. The next
  // publish:fixed picks up anything missed (published.json is the dedupe).
  if (pendingFixes.length > 0) {
    try {
      await publishFixed({ range: releaseRange(tag) });
    } catch (err) {
      console.error(`[release] #fixed announce failed (release is fine):`, err?.message ?? err);
      console.error(`[release] re-run later with: npm run publish:fixed`);
    }
  }

  // Community #releases announce rides the mirror for the same reason: the
  // mirror is what makes the update installable. Non-fatal, same as #fixed.
  try {
    await announceRelease();
  } catch (err) {
    console.error(`[release] #releases announce failed (release is fine):`, err?.message ?? err);
  }
} catch (err) {
  console.error(`[release-mirror] failed to mirror ${tag} to ${PUBLIC_MIRROR}:`, err?.message ?? err);
  console.error(`[release-mirror] private publish above is unaffected — auto-update will not pick up this version until the mirror succeeds`);
}

console.log(`[release] the installed o8.app will pick up the update on next launch`);
console.log(`[release] (or within 30 min via the UpdateBanner poll).`);

/** env wins; else the gitignored o8.release.json — never a literal in source. */
function resolveReleasesWebhook() {
  const fromEnv = process.env.O8_RELEASES_WEBHOOK_URL?.trim();
  if (fromEnv) return fromEnv;
  try {
    const cfg = JSON.parse(readFileSync(join(root, 'o8.release.json'), 'utf8'));
    const url = typeof cfg.releasesWebhookUrl === 'string' ? cfg.releasesWebhookUrl.trim() : '';
    return url || null;
  } catch {
    return null;
  }
}

/**
 * Bullets are the release range's public feat/perf/design subjects. A trailing
 * parenthetical is stripped because commit-local context does not belong in a
 * community announcement.
 */
function composeReleaseAnnouncement() {
  let subjects = [];
  try {
    subjects = execFileSync('git', ['log', '--format=%s', '--no-merges', releaseRange(tag)], { encoding: 'utf8' })
      .split('\n')
      .filter((s) => /^(feat|perf|design)(\(.*\))?:/.test(s));
  } catch {}
  const bullets = subjects
    .map((s) => s
      .replace(/^(feat|perf|design)(\([^)]*\))?:\s*/, '')
      .replace(/\s*\(#\d+\)/g, '')
      .replace(/\s*#\d+/g, '')
      // A trailing parenthetical in a subject is internal context
      // ("(t3-connect answer)", codenames) — never community-facing.
      .replace(/\s*\([^)]*\)\s*$/, '')
      .trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((s) => `- ${s.charAt(0).toUpperCase()}${s.slice(1)}`);
  const date = new Date().toISOString().slice(0, 10);
  // SOURCE_REPO is the real code repo, linked ALONGSIDE the release mirror once it goes public.
  // Deliberately empty today: hurttlocker/o8 is still PRIVATE (verified via `gh repo view`
  // 2026-07-31), and linking it now sends the whole server to a 404. Flip this to 'hurttlocker/o8'
  // the day the repo flips — that is the only edit needed.
  const sourceLine = SOURCE_REPO
    ? `Source: https://github.com/${SOURCE_REPO}`
    : null;
  return [
    '@everyone',
    `**o8 ${tag}** — ${date}`,
    '',
    ...(bullets.length ? bullets : ['- Fixes and maintenance.']),
    '',
    `Update: relaunch o8 (auto-updates within 30 min), or grab it fresh: https://github.com/${PUBLIC_MIRROR}/releases/tag/${tag}`,
    ...(sourceLine ? [sourceLine] : []),
  ].join('\n');
}

async function announceRelease() {
  const webhookUrl = resolveReleasesWebhook();
  if (!webhookUrl) {
    console.log('[release] no #releases webhook configured — skipping community announce');
    return;
  }
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // allowed_mentions is REQUIRED for the ping to land: a webhook can contain the literal
    // "@everyone" and Discord will render it as inert text unless "everyone" is parsed here.
    body: JSON.stringify({
      username: 'o8',
      content: composeReleaseAnnouncement(),
      allowed_mentions: { parse: ['everyone'] },
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Discord returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 180)}` : ''}`);
  }
  console.log('[release] announced in community #releases');
}
