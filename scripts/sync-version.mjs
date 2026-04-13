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

execFileSync('git', ['add', tauriConfPath, cargoPath], { stdio: 'inherit' });

console.log(`[sync-version] ${oldTauriVersion ?? '?'} → ${newVersion}`);
console.log(`  src-tauri/tauri.conf.json   ${oldTauriVersion ?? '?'} → ${newVersion}`);
console.log(`  src-tauri/Cargo.toml        ${oldCargoVersion ?? '?'} → ${newVersion}`);
console.log(`  staged for commit`);
