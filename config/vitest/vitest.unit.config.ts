import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { require as tsxRequire } from 'tsx/cjs/api';
import { defineConfig } from 'vitest/config';
import { sharedVitestConfig } from './vitest.shared';

// Reporting and scheduling do not affect application transforms. Load them
// outside the config bundle so tuning them preserves Vitest's module cache.
const { default: DurationSequencer } = tsxRequire('./duration-sequencer.ts', import.meta.url) as {
  default: typeof import('./duration-sequencer').default;
};

const classification = JSON.parse(readFileSync(
  new URL('../../tests/test-classification.json', import.meta.url),
  'utf8',
)) as { resourceOwning: Array<{ path: string }> };
const excluded = classification.resourceOwning.map((entry) => entry.path);

export default defineConfig({
  ...sharedVitestConfig,
  test: {
    ...sharedVitestConfig.test,
    name: 'hermetic-unit',
    exclude: excluded,
    pool: 'forks',
    isolate: true,
    fileParallelism: true,
    maxWorkers: Math.min(4, availableParallelism()),
    // Cache compiled code, never globals, mocks or fixture/application state.
    env: { NODE_COMPILE_CACHE: path.resolve(__dirname, '../../node_modules/.cache/vitest-node') },
    experimental: { fsModuleCache: true },
    sequence: { sequencer: DurationSequencer },
    reporters: [
      'default',
      path.resolve(__dirname, 'test-timing-reporter.ts'),
      ...(process.env.O8_TEST_GATE_REPORT_PATH
        ? [['json', { outputFile: process.env.O8_TEST_GATE_REPORT_PATH }] as ['json', { outputFile: string }]]
        : []),
    ],
  },
});
