import { defineConfig } from 'vitest/config';
import { sharedVitestConfig } from '../../../config/vitest/vitest.shared';

// Exercise the production setup without recursively collecting the parent test.
export default defineConfig({
  ...sharedVitestConfig,
  test: {
    ...sharedVitestConfig.test,
    include: ['tests/fixtures/data-handoff-real-path/probe.fixture.ts'],
    fileParallelism: false,
  },
});
