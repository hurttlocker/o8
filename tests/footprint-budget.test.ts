import { describe, expect, it } from 'vitest';
import {
  FOOTPRINT_BUDGET,
  collectFootprintReceipt,
  descendantPids,
  evaluateFootprintBudget,
  parseCpuTimeSeconds,
  parseFootprintBytes,
  parseProcessTable,
  webkitPids,
} from '../scripts/lib/footprint-budget.mjs';

const MIB = 1024 * 1024;

function processTable(extra = '') {
  return parseProcessTable(`
100 1 Thu Aug 27 07:00:00 2026 0:10.00 /bundle/o8
101 100 Thu Aug 27 07:00:01 2026 0:04.00 next-server (v16)
102 100 Thu Aug 27 07:00:01 2026 0:02.00 /bundle/ws-server.mjs
201 1 Thu Aug 27 07:00:02 2026 0:03.00 /System/WebKit.framework/WebKit.WebContent.xpc/Contents/MacOS/WebKit.WebContent
${extra}`);
}

describe('footprint budget', () => {
  it('parses physical-footprint and CPU-time units', () => {
    expect(parseFootprintBytes('o8 [1]: Footprint: 490 MB (4096 bytes per page)')).toBe(490 * MIB);
    expect(parseFootprintBytes('node [2]: Footprint: 1.5 GB')).toBe(1536 * MIB);
    expect(parseCpuTimeSeconds('8:28.11')).toBeCloseTo(508.11);
    expect(parseCpuTimeSeconds('1:02:03.50')).toBeCloseTo(3723.5);
    expect(parseCpuTimeSeconds('2-01:02:03.50')).toBeCloseTo(176523.5);
  });

  it('attributes descendants and newly launched WebKit helpers without command-path guessing', () => {
    const processes = processTable('103 101 Thu Aug 27 07:00:02 2026 0:01.00 helper');
    expect([...descendantPids(processes, 100)].sort()).toEqual([100, 101, 102, 103]);
    expect([...webkitPids(processes)]).toEqual([201]);
  });

  it('fails only the regression ceiling while retaining the lower product target', () => {
    const metrics = {
      appBundleBytes: 200 * MIB,
      idlePhysicalBytes: 1100 * MIB,
      idleCpuPercent: 3,
      idleProcessChurn: 0,
      components: {
        nativeHost: { bytes: 500 * MIB, cpuPercent: 2 },
        applicationServer: { bytes: 250 * MIB, cpuPercent: 5 },
        realtimeServer: { bytes: 120 * MIB, cpuPercent: 4 },
        webkitContent: { bytes: 230 * MIB, cpuPercent: 4 },
      },
    };
    expect(metrics.idlePhysicalBytes).toBeGreaterThan(FOOTPRINT_BUDGET.targets.idlePhysicalBytes);
    expect(evaluateFootprintBudget(metrics).pass).toBe(true);
    expect(evaluateFootprintBudget({ ...metrics, idleProcessChurn: 1 }).failures)
      .toEqual([expect.objectContaining({ metric: 'idleProcessChurn' })]);
  });

  it('builds a redacted versioned receipt from the real process-table contract', () => {
    const before = processTable();
    const after = parseProcessTable(`
100 1 Thu Aug 27 07:00:00 2026 0:10.20 /bundle/o8
101 100 Thu Aug 27 07:00:01 2026 0:04.10 next-server (v16)
102 100 Thu Aug 27 07:00:01 2026 0:02.05 /bundle/ws-server.mjs
201 1 Thu Aug 27 07:00:02 2026 0:03.05 /System/WebKit.framework/WebKit.WebContent.xpc/Contents/MacOS/WebKit.WebContent
`);
    const commandOutput = new Map([
      ['100', 'o8 [100]: Footprint: 400 MB'],
      ['101', 'node [101]: Footprint: 200 MB'],
      ['102', 'node [102]: Footprint: 100 MB'],
      ['201', 'WebContent [201]: Footprint: 150 MB'],
    ]);
    const run = (command: string, args: string[]) => {
      if (command === 'du') return '204800 /redacted\n';
      if (command === 'footprint') return commandOutput.get(args[1]) ?? '';
      throw new Error(`unexpected command: ${command}`);
    };
    const receipt = collectFootprintReceipt({
      rootPid: 100,
      appPath: '/redacted/app',
      dataDir: '/redacted/data',
      webkitBaseline: new Set(),
      before,
      after,
      observationMs: 10_000,
      version: '0.1.0',
      gitSha: 'abc123',
      mode: 'test',
      scenario: 'idle-hidden',
      recordedAt: '2026-08-27T00:00:00.000Z',
      run,
    });
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      budgetVersion: 1,
      scenario: 'idle-hidden',
      verdict: 'PASS',
      metrics: {
        idlePhysicalBytes: 850 * MIB,
        idleCpuPercent: 4,
        idleProcessChurn: 0,
        components: {
          nativeHost: { processCount: 1, bytes: 400 * MIB, cpuPercent: 2 },
          applicationServer: { processCount: 1, bytes: 200 * MIB, cpuPercent: 1 },
          realtimeServer: { processCount: 1, bytes: 100 * MIB, cpuPercent: 0.5 },
          webkitContent: { processCount: 1, bytes: 150 * MIB, cpuPercent: 0.5 },
        },
      },
    });
    expect(JSON.stringify(receipt)).not.toContain('/redacted');
  });
});
