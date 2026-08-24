import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // Next's 'server-only' poison-pill throws outside a React Server
      // Components bundler. Tests run in plain Node — stub it out.
      'server-only': path.resolve(__dirname, 'tests/stubs/server-only.ts'),
    },
  },
  test: {
    environment: 'node',
    globalSetup: ['tests/global-test-data-dir.ts'],
    // Hermetic data dir for EVERY worker before any app module loads — see file.
    setupFiles: ['tests/setup-isolated-data-dir.ts'],
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts', 'cli/**/*.test.ts'],
    // Keep the default local gate identical to CI. This suite includes real
    // Git, APFS, worktree, and child-process tests; CPU-count parallelism turns
    // resource contention into timeouts and teardown cascades (#1633).
    fileParallelism: false,
    // No globals — tests import { describe, it, expect } from 'vitest'
    // explicitly so tsc/eslint see real symbols.
    globals: false,
    // Vitest defaults to 5s. Much of this suite does real work — real git,
    // real filesystem, real route handlers, parsing every route file with the
    // TypeScript compiler — and on a machine that is busy (a fleet of workers,
    // a build, a screen encoder) those legitimately run past 5s. Failing then
    // reports a timeout as a broken test and, through the merge gate's
    // post-rebase typecheck, blocks merges for reasons unrelated to the code.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
