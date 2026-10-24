import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import DurationSequencer from './duration-sequencer';
import TestTimingReporter from './test-timing-reporter';
import { sharedVitestConfig } from './vitest.shared';

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
      new TestTimingReporter(),
      ...(process.env.O8_TEST_GATE_REPORT_PATH
        ? [['json', { outputFile: process.env.O8_TEST_GATE_REPORT_PATH }] as ['json', { outputFile: string }]]
        : []),
    ],
  },
});
