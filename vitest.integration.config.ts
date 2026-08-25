import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { sharedVitestConfig } from './vitest.shared';

const classification = JSON.parse(readFileSync(
  new URL('./tests/test-classification.json', import.meta.url),
  'utf8',
)) as { resourceOwning: Array<{ path: string }> };

export default defineConfig({
  ...sharedVitestConfig,
  test: {
    ...sharedVitestConfig.test,
    name: 'resource-integration',
    include: classification.resourceOwning.map((entry) => entry.path),
    pool: 'forks',
    isolate: true,
    fileParallelism: false,
    maxWorkers: 1,
    ...(process.env.O8_TEST_GATE_REPORT_PATH ? {
      reporters: ['default', ['json', { outputFile: process.env.O8_TEST_GATE_REPORT_PATH }]],
    } : {}),
  },
});
