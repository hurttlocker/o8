import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { TestModule, Vitest } from 'vitest/node';
import type { Reporter } from 'vitest/reporters';

// Vitest's JSON reporter only times test bodies. Include importing the file,
// its environment and setup so a costly fixture cannot disappear from the list.
export default class TestTimingReporter implements Reporter {
  private context!: Vitest;
  private started = 0;

  onInit(context: Vitest) {
    this.context = context;
  }

  onTestRunStart() {
    this.started = performance.now();
  }

  onTestRunEnd(modules: ReadonlyArray<TestModule>) {
    const round = (value: number) => Math.round(value * 100) / 100;
    const files = modules.map((module) => {
      const timing = module.diagnostic();
      return {
        path: module.relativeModuleId.replaceAll('\\', '/'),
        state: module.state(),
        tests: [...module.children.allTests()].length,
        totalMs: round(timing.prepareDuration + timing.environmentSetupDuration
          + timing.setupDuration + timing.collectDuration + timing.duration),
        prepareMs: round(timing.prepareDuration),
        environmentMs: round(timing.environmentSetupDuration),
        collectMs: round(timing.collectDuration),
        setupMs: round(timing.setupDuration),
        testsMs: round(timing.duration),
      };
    }).sort((a, b) => b.totalMs - a.totalMs || a.path.localeCompare(b.path));
    const fields = ['prepareMs', 'environmentMs', 'setupMs', 'collectMs', 'testsMs'] as const;
    const phaseTotals = Object.fromEntries(fields.map(field => [
      field, round(files.reduce((sum, file) => sum + file[field], 0)),
    ]));
    const report = {
      schema: 'o8/test-timings/v1',
      wallMs: round(performance.now() - this.started),
      phaseTotals,
      files,
    };
    const output = process.env.O8_TEST_TIMING_REPORT_PATH;
    if (output) {
      const target = resolve(output);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
    }
    this.context.logger.log('[test-timing] phase totals (overlap across workers), ms: '
      + fields.map(field => `${field} ${phaseTotals[field].toFixed(0)}`).join(', '));
    this.context.logger.log('[test-timing] slowest files (environment + setup + imports + tests), ms');
    for (const file of files.slice(0, 30)) {
      this.context.logger.log(`[test-timing] ${file.totalMs.toFixed(0)} ${file.path}`
        + ` (prepare ${file.prepareMs.toFixed(0)}, environment ${file.environmentMs.toFixed(0)},`
        + ` setup ${file.setupMs.toFixed(0)}, imports ${file.collectMs.toFixed(0)}, tests ${file.testsMs.toFixed(0)})`);
    }
    for (const [label, field] of [['imports', 'collectMs'], ['environment', 'environmentMs'], ['setup', 'setupMs']] as const) {
      this.context.logger.log(`[test-timing] slowest ${label}, ms`);
      for (const file of [...files].sort((a, b) => b[field] - a[field]).slice(0, 5)) {
        this.context.logger.log(`[test-timing] ${file[field].toFixed(0)} ${file.path}`);
      }
    }
  }
}
