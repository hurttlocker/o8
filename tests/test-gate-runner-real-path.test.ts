import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const fixturePids = new Set<number>();
const fixturePidFiles: string[] = [];

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function rememberFixturePids(): void {
  for (const pidFile of fixturePidFiles) {
    try {
      const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
      if (Number.isSafeInteger(pid) && pid > 0) fixturePids.add(pid);
    } catch {}
  }
}

async function waitUntilGone(pids: number[]): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && pids.some(isPidAlive)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

afterEach(async () => {
  rememberFixturePids();
  const pids = [...fixturePids];
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    for (const pid of pids) {
      try { process.kill(pid, signal); } catch {}
    }
    await waitUntilGone(pids);
    if (!pids.some(isPidAlive)) break;
  }
  const survivors = pids.filter(isPidAlive);
  fixturePids.clear();
  fixturePidFiles.length = 0;
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
  expect(survivors).toEqual([]);
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

  it('times out one hanging file, verifies its tree is gone, and continues to the next file', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'o8-integration-file-timeout-'));
    roots.push(fixture);
    const orderLog = join(fixture, 'order.log');
    const hangingPidFile = join(fixture, 'hanging-worker.pid');
    fixturePidFiles.push(hangingPidFile);
    const hanging = join(fixture, 'hanging.test.js');
    const passing = join(fixture, 'passing.test.js');
    const configPath = join(fixture, 'integration.config.mjs');
    const summaryReportPath = join(fixture, 'gate-report.json');
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
    writeFileSync(hanging, `
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
it('hangs with an escaped child', async () => {
  appendFileSync(${JSON.stringify(orderLog)}, 'hanging\\n');
  const worker = spawn(process.execPath, ['-e', "const marker = 'o8-test-gate-hanging-worker'; setInterval(() => marker, 1000);"], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  writeFileSync(${JSON.stringify(hangingPidFile)}, String(worker.pid));
  worker.unref();
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}, 60_000);
`);
    writeFileSync(passing, `
import { appendFileSync } from 'node:fs';
it('runs after the timed-out file', () => {
  appendFileSync(${JSON.stringify(orderLog)}, 'passing\\n');
  expect(true).toBe(true);
});
`);
    const planPath = join(fixture, 'integration-plan.json');
    writeFileSync(planPath, JSON.stringify({ config: configPath, files: [hanging, passing] }));

    const result = spawnSync(process.execPath, ['scripts/integration-test-gate.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        O8_INTEGRATION_TEST_MODE: '1',
        O8_INTEGRATION_TEST_PLAN: planPath,
        O8_TEST_GATE_FILE_TIMEOUT_MS: '3000',
        O8_TEST_GATE_HEARTBEAT_MS: '100000',
        O8_TEST_GATE_REPORT_PATH: summaryReportPath,
      },
    });
    const retainedRoot = result.stderr.match(/retained \d+ timeout receipts? under (.+)/)?.[1]?.trim();
    if (retainedRoot) roots.push(retainedRoot);
    rememberFixturePids();
    const hangingPid = [...fixturePids][0];

    expect(result.status).toBe(1);
    expect(result.error).toBeUndefined();
    expect(readFileSync(orderLog, 'utf8').trim().split('\n')).toEqual(['hanging', 'passing']);
    expect(result.stdout).toContain(`FAIL ${hanging}`);
    expect(result.stdout).toContain('timeout after 3s');
    expect(result.stdout).toContain(`PASS ${passing}`);
    expect(result.stdout).toContain('2/2 files');
    expect(result.stderr).toContain('retained 1 timeout receipt');
    expect(result.stderr).not.toContain('TREE UNCONFIRMED');
    expect(retainedRoot).toBeTruthy();
    const receipt = JSON.parse(readFileSync(join(retainedRoot!, '.o8-test-run-retain.json'), 'utf8')) as {
      reason: string;
      file: string;
      timeoutMs: number;
    };
    expect(receipt).toMatchObject({ reason: 'test_gate_file_timeout', file: hanging, timeoutMs: 3_000 });
    const report = JSON.parse(readFileSync(summaryReportPath, 'utf8')) as {
      testResults: Array<{ assertionResults: Array<{ fullName: string }> }>;
    };
    expect(report.testResults[0]?.assertionResults[0]?.fullName).toContain('timeout after 3s');
    expect(hangingPid).toBeTypeOf('number');
    expect(() => process.kill(hangingPid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  }, 40_000);
});
