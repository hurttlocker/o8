import { defineConfig } from 'vitest/config';
import { sharedVitestConfig } from './vitest.shared';

export default defineConfig({
  ...sharedVitestConfig,
  test: {
    ...sharedVitestConfig.test,
    // Direct `npx vitest run <path>` remains predictable for focused work.
    // `npm test` uses the separate bounded-parallel and serial configurations.
    fileParallelism: false,
  },
});
