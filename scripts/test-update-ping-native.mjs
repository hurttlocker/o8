import { copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Reuse the desktop dependency versions without compiling or launching its sidecars.
const root = new URL('../', import.meta.url);
const fixture = new URL('tests/fixtures/update-ping-native/', root);
copyFileSync(new URL('src-tauri/Cargo.lock', root), new URL('Cargo.lock', fixture));
const result = spawnSync('cargo', ['test', '--manifest-path', 'tests/fixtures/update-ping-native/Cargo.toml'], {
  cwd: root,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
