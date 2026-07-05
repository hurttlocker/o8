#!/usr/bin/env node
/*
 * Detach leftover Tauri dmg build mounts (/Volumes/dmg.*).
 *
 * `cargo tauri build`'s dmg bundler (bundle_dmg.sh) mounts a dmg to lay out the
 * .app and occasionally fails to unmount it (volume busy). Each leftover mount
 * contains an o8.app that registers the `o8://` URL scheme with Launch Services —
 * and macOS then routes the desktop sign-in deep link (o8://auth/callback) to a
 * phantom dmg copy instead of /Applications/o8.app, silently breaking sign-in.
 *
 * Wired pre + post `npm run ship` so these can never accumulate again. Best-effort:
 * a busy or already-gone mount is skipped, never fatal. Root-cause of the
 * 2026-07-05 "signed in on web but the app never caught the callback" incident.
 */
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

let detached = 0;
let volumes = [];
try {
  volumes = readdirSync('/Volumes').filter((name) => name.startsWith('dmg.'));
} catch {
  // /Volumes unreadable — nothing to do.
}

for (const name of volumes) {
  try {
    execFileSync('hdiutil', ['detach', `/Volumes/${name}`, '-force'], { stdio: 'ignore' });
    detached += 1;
  } catch {
    // Busy or already unmounted — skip, never fail the ship over cleanup.
  }
}

console.log(`[detach-stale-dmg] detached ${detached} leftover dmg mount(s)`);
