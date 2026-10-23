import { copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Reuse the desktop dependency versions without compiling or launching its sidecars.
const root = new URL('../', import.meta.url);
const fixture = new URL('tests/fixtures/update-ping-native/', root);
copyFileSync(new URL('src-tauri/Cargo.lock', root), new URL('Cargo.lock', fixture));
// Run the reservation protocol regressions as well as its updater callers.
for (const [manifest, args] of [
  ['crates/o8-restart-safety/Cargo.toml', ['--lib', '--', '--nocapture']],
  ['tests/fixtures/update-ping-native/Cargo.toml', []],
]) {
  const result = spawnSync('cargo', ['test', '--manifest-path', manifest, ...args], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
