import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('split test gate real entry point', () => {
  it('finishes the hermetic gate before an integration failure and reports the causal lane', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'o8-test-gate-runner-'));
    roots.push(fixture);
    const orderLog = join(fixture, 'order.log');
    const config = (file: string) => `
export default {
  test: {
    root: ${JSON.stringify(fixture)},
    globals: true,
    include: [${JSON.stringify(file)}],
    reporters: process.env.O8_TEST_GATE_REPORT_PATH
      ? ['default', ['json', { outputFile: process.env.O8_TEST_GATE_REPORT_PATH }]]
      : ['default'],
  },
};
`;
    writeFileSync(join(fixture, 'unit.config.mjs'), config('unit.test.js'));
    writeFileSync(join(fixture, 'integration.config.mjs'), config('integration.test.js'));
    writeFileSync(join(fixture, 'unit.test.js'), `
import { appendFileSync } from 'node:fs';
it('unit passes first', () => {
  appendFileSync(${JSON.stringify(orderLog)}, 'unit\\n');
  expect(2 + 2).toBe(4);
});
`);
    writeFileSync(join(fixture, 'integration.test.js'), `
import { appendFileSync } from 'node:fs';
it('integration fails second', () => {
  appendFileSync(${JSON.stringify(orderLog)}, 'integration\\n');
  expect('fixture failure').toBe('healthy');
});
`);
    const planPath = join(fixture, 'plan.json');
    writeFileSync(planPath, JSON.stringify([
      { id: 'unit', label: 'Hermetic fixture', config: join(fixture, 'unit.config.mjs') },
      { id: 'integration', label: 'Integration fixture', config: join(fixture, 'integration.config.mjs') },
    ]));

    const result = spawnSync(process.execPath, ['scripts/test-gates.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        O8_TEST_GATE_TEST_MODE: '1',
        O8_TEST_GATE_PLAN: planPath,
        O8_TEST_GATE_HEARTBEAT_MS: '100000',
      },
    });

    expect(result.status).toBe(1);
    expect(readFileSync(orderLog, 'utf8').trim().split('\n')).toEqual(['unit', 'integration']);
    expect(result.stdout).toContain('Hermetic fixture: PASS');
    expect(result.stdout).toContain('Integration fixture: FAIL');
    expect(result.stderr).toContain('failure-class=resource_or_integration_failure');
  }, 40_000);

  it('gives every resource-owning file a fresh process after an earlier file fails', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'o8-integration-fresh-process-'));
    roots.push(fixture);
    const orderLog = join(fixture, 'order.log');
    const first = join(fixture, 'first.test.js');
    const second = join(fixture, 'second.test.js');
    const configPath = join(fixture, 'integration.config.mjs');
    writeFileSync(configPath, `
export default {
  test: {
    root: ${JSON.stringify(fixture)},
    globals: true,
    include: ['*.test.js'],
    reporters: process.env.O8_TEST_GATE_REPORT_PATH
      ? ['default', ['json', { outputFile: process.env.O8_TEST_GATE_REPORT_PATH }]]
      : ['default'],
  },
};
`);
    writeFileSync(first, `
import { appendFileSync } from 'node:fs';
it('poisons only its disposable process', () => {
  globalThis.__fixturePoison = true;
  process.env.O8_FIXTURE_POISON = '1';
  appendFileSync(${JSON.stringify(orderLog)}, 'first\\n');
  expect('broken fixture').toBe('healthy');
});
`);
    writeFileSync(second, `
import { appendFileSync } from 'node:fs';
it('starts clean after the failure', () => {
  appendFileSync(${JSON.stringify(orderLog)}, 'second\\n');
  expect(globalThis.__fixturePoison).toBeUndefined();
  expect(process.env.O8_FIXTURE_POISON).toBeUndefined();
});
`);
    const planPath = join(fixture, 'integration-plan.json');
    writeFileSync(planPath, JSON.stringify({ config: configPath, files: [first, second] }));

    const result = spawnSync(process.execPath, ['scripts/integration-test-gate.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        O8_INTEGRATION_TEST_MODE: '1',
        O8_INTEGRATION_TEST_PLAN: planPath,
        O8_TEST_GATE_HEARTBEAT_MS: '100000',
      },
    });

    expect(result.status).toBe(1);
    expect(readFileSync(orderLog, 'utf8').trim().split('\n')).toEqual(['first', 'second']);
    expect(result.stdout).toContain(`FAIL ${first}`);
    expect(result.stdout).toContain(`PASS ${second}`);
    expect(result.stdout).toContain('2/2 files');
  }, 40_000);
});
