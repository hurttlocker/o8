#!/usr/bin/env node
// Runs as the `version` npm hook — fires AFTER package.json is bumped but
// BEFORE the version commit lands. Mirrors the new version into
// tauri.conf.json + src-tauri/Cargo.toml so all three manifests stay in
// lockstep, then stages them so the npm version commit picks them up.
//
// Without this the Tauri updater would never trigger: it compares the
// installed app's tauri.conf.json version against the latest release, and
// `npm version` only touches package.json.

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = process.cwd();
const pkgPath = resolve(root, 'package.json');
const tauriConfPath = resolve(root, 'src-tauri/tauri.conf.json');
const cargoPath = resolve(root, 'src-tauri/Cargo.toml');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const newVersion = pkg.version;

if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(newVersion)) {
  console.error(`[sync-version] refusing to sync invalid semver: ${newVersion}`);
  process.exit(1);
}

const tauriConf = JSON.parse(readFileSync(tauriConfPath, 'utf8'));
const oldTauriVersion = tauriConf.version;
tauriConf.version = newVersion;
writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n');

const cargo = readFileSync(cargoPath, 'utf8');
let inPackageSection = false;
let oldCargoVersion = null;
// The crate name as Cargo.lock spells it, so the lock edit below targets OUR
// package rather than the first `version =` it happens to meet.
const cargoCrateName = cargo.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ?? 'o8';
const updatedCargo = cargo.split('\n').map((line) => {
  const trimmed = line.trim();
  if (trimmed === '[package]') {
    inPackageSection = true;
    return line;
  }
  if (inPackageSection && trimmed.startsWith('[') && trimmed.endsWith(']')) {
    inPackageSection = false;
    return line;
  }
  if (inPackageSection && /^version\s*=/.test(trimmed)) {
    const match = line.match(/^(\s*version\s*=\s*")([^"]+)(".*)$/);
    if (match) {
      oldCargoVersion = match[2];
      return `${match[1]}${newVersion}${match[3]}`;
    }
  }
  return line;
}).join('\n');
writeFileSync(cargoPath, updatedCargo);

// Cargo.lock records the workspace crate's own version too, and it is a FOURTH
// manifest that has to move in lockstep. It was missed until 2026-08-04, by
// which point the committed lock said 0.1.650 against a 0.1.653 Cargo.toml —
// enough drift that any `cargo <cmd> --locked` refused to run, which is exactly
// what CI wants to use. The ship flow's `git checkout -- src-tauri/Cargo.lock`
// (discarding post-build noise) is what kept re-losing the regenerated value,
// so syncing it here, before the version commit, is the durable fix.
//
// Targeted edit rather than a `cargo update` shellout: this hook runs inside
// `npm version` where a network resolve would be slow and could change
// dependency versions as a side effect of a patch bump.
const lockPath = resolve(root, 'src-tauri/Cargo.lock');
let oldLockVersion = null;
try {
  const lock = readFileSync(lockPath, 'utf8');
  let inOwnPackage = false;
  const updatedLock = lock.split('\n').map((line) => {
    const trimmed = line.trim();
    if (trimmed === '[[package]]') {
      inOwnPackage = false;
      return line;
    }
    if (trimmed === `name = "${cargoCrateName}"`) {
      inOwnPackage = true;
      return line;
    }
    if (inOwnPackage && /^version\s*=/.test(trimmed)) {
      const match = line.match(/^(\s*version\s*=\s*")([^"]+)(".*)$/);
      if (match) {
        oldLockVersion = match[2];
        inOwnPackage = false;
        return `${match[1]}${newVersion}${match[3]}`;
      }
    }
    return line;
  }).join('\n');
  if (oldLockVersion !== null) writeFileSync(lockPath, updatedLock);
} catch {
  // A missing lock is not fatal — it regenerates on the next cargo command.
}

const staged = [tauriConfPath, cargoPath];
if (oldLockVersion !== null) staged.push(lockPath);
execFileSync('git', ['add', ...staged], { stdio: 'inherit' });

console.log(`[sync-version] ${oldTauriVersion ?? '?'} → ${newVersion}`);
console.log(`  src-tauri/tauri.conf.json   ${oldTauriVersion ?? '?'} → ${newVersion}`);
console.log(`  src-tauri/Cargo.toml        ${oldCargoVersion ?? '?'} → ${newVersion}`);
console.log(`  src-tauri/Cargo.lock        ${oldLockVersion ?? 'unchanged'} → ${oldLockVersion !== null ? newVersion : 'unchanged'}`);
console.log(`  staged for commit`);
