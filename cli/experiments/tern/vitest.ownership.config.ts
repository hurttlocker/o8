import { defineConfig } from 'vitest/config';
import { sharedVitestConfig } from '../../../config/vitest/vitest.shared';

// Reuse o8's data isolation and aliases. This resource-owning experiment is
// explicit-only: it is not silently added to the hermetic/default test lane.
export default defineConfig({
  ...sharedVitestConfig,
  test: {
    ...sharedVitestConfig.test,
    name: 'tern-pi-ownership',
    include: ['cli/experiments/tern/ownership.test.mjs'],
    pool: 'forks',
    isolate: true,
    fileParallelism: false,
    maxWorkers: 1,
  },
});
