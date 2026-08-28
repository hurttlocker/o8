#!/usr/bin/env node
/**
 * Production Next build (#1744). Replaces the POSIX one-liner
 *
 *   sh -c 'node scripts/bust-stale-patch-cache.mjs && env -u TURBOPACK \
 *     -u NEXT_DEPLOYMENT_ID -u __NEXT_PRIVATE_ORIGIN \
 *     -u __NEXT_PRIVATE_STANDALONE_CONFIG NODE_ENV=production \
 *     NODE_OPTIONS=--max-old-space-size=24576 next build --webpack'
 *
 * which cmd.exe cannot run. Same two steps, same env delta, same exit-code
 * semantics — `env -u` becomes a delete, the assignments become writes, and
 * the second step still only runs when the first exits 0.
 *
 * This is on the ship path (`tauri:prebuild` -> `npm run build`), so the
 * `next` entry is resolved through `require.resolve` and run with
 * `process.execPath` rather than the `node_modules/.bin` shim. On macOS the
 * shim is a symlink to that exact file with an `#!/usr/bin/env node` shebang,
 * so this is the same program under the same interpreter.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolveReleaseConfig } from './lib/release-config.mjs';

const require = createRequire(import.meta.url);
const root = process.cwd();

// Next's persistent webpack cache treats node_modules as immutable, so a fresh
// patch-package edit has to invalidate it explicitly. See the script's header.
const bust = spawnSync(process.execPath, ['scripts/bust-stale-patch-cache.mjs'], {
  cwd: root,
  stdio: 'inherit',
});
if (bust.error) throw bust.error;
if (bust.status !== 0) process.exit(bust.status ?? 1);

const env = { ...process.env };
const releaseConfig = resolveReleaseConfig(root, env);
if (!env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && releaseConfig.clerkPublishableKey) {
  env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = releaseConfig.clerkPublishableKey;
  console.log('[build] Clerk publishable key loaded from release config');
}
// `env -u ...`: a stale TURBOPACK or inherited __NEXT_PRIVATE_* from a running
// dev server silently changes what `next build` produces.
for (const key of [
  'TURBOPACK',
  'NEXT_DEPLOYMENT_ID',
  '__NEXT_PRIVATE_ORIGIN',
  '__NEXT_PRIVATE_STANDALONE_CONFIG',
]) {
  delete env[key];
}
env.NODE_ENV = 'production';
env.NODE_OPTIONS = '--max-old-space-size=24576';

const build = spawnSync(
  process.execPath,
  [require.resolve('next/dist/bin/next'), 'build', '--webpack'],
  { cwd: root, stdio: 'inherit', env },
);
if (build.error) throw build.error;
process.exit(build.status ?? 1);
