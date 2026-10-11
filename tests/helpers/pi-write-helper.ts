import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const CRATE = join(process.cwd(), 'src-tauri', 'sidecars', 'pi-write');

/**
 * Builds the native approved-write helper (#3289) with cargo and returns its
 * path. The source checkout resolves the default build in place. With hooks, the
 * test build runs `<helper dir>/hook <point> <pid>` at named points and waits
 * for it, so a test can mutate the workspace at an exact step.
 */
export function buildPiWriteHelper({ hooks = false }: { hooks?: boolean } = {}): string {
  const targetDir = hooks ? join(CRATE, 'target', 'test-hooks') : join(CRATE, 'target');
  const result = spawnSync('cargo', ['build', '--release', '--locked', '--manifest-path', join(CRATE, 'Cargo.toml'),
    '--target-dir', targetDir, ...(hooks ? ['--features', 'test-hooks'] : [])], { encoding: 'utf8', timeout: 600_000 });
  if (result.status !== 0) throw new Error(`cargo build of the Pi write helper failed: ${result.error?.message ?? result.stderr}`);
  return join(targetDir, 'release', 'o8-pi-write');
}
