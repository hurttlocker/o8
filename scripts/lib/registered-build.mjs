import { createRequire } from 'node:module';
import { join } from 'node:path';
import { resolveReleaseConfig } from './release-config.mjs';

/** Invoked only after generated-output exclusion and producer reservation. */
export async function runRegisteredBuild(run) {
  const root = process.cwd();
  const require = createRequire(join(root, 'package.json'));
  const heapMiB = process.env.O8_BUILD_HEAP_MIB === undefined ? 24576 : Number(process.env.O8_BUILD_HEAP_MIB);
  if (!Number.isSafeInteger(heapMiB) || heapMiB < 1024 || heapMiB > 24576) {
    throw new Error('O8_BUILD_HEAP_MIB must be an integer from 1024 through 24576.');
  }
  const bust = await run(process.execPath, ['scripts/bust-stale-patch-cache.mjs']);
  if (bust !== 0) return bust;
  const env = { ...process.env };
  const releaseConfig = resolveReleaseConfig(root, env);
  if (!env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && releaseConfig.clerkPublishableKey) {
    env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = releaseConfig.clerkPublishableKey;
    console.log('[build] Clerk publishable key loaded from release config');
  }
  for (const key of ['TURBOPACK', 'NEXT_DEPLOYMENT_ID', '__NEXT_PRIVATE_ORIGIN', '__NEXT_PRIVATE_STANDALONE_CONFIG']) {
    delete env[key];
  }
  env.NODE_ENV = 'production';
  env.NODE_OPTIONS = `--max-old-space-size=${heapMiB}`;
  return run(process.execPath, [require.resolve('next/dist/bin/next'), 'build', '--webpack'], env);
}
