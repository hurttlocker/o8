import { describe, expect, it } from 'vitest';
// @ts-expect-error -- the benchmark checker is intentionally native ESM without generated declarations.
import { checkTerminalWorkloadBudgets } from '../scripts/bench/terminal-workload/budgets.mjs';

function distribution(p50: number, p95 = p50) {
  return { samples: 3, min: p50, p50, p95, max: p95 };
}

function receipt() {
  const processCpuPercent = {
    applicationServer: distribution(10),
    realtimeServer: distribution(12, 18),
    chromiumRenderer: distribution(18, 24),
  };
  const processPhysicalBytes = {
    applicationServer: distribution(300 * 1024 * 1024),
    realtimeServer: distribution(150 * 1024 * 1024),
    chromiumRenderer: distribution(220 * 1024 * 1024),
  };
  const summary = {
    sampleCount: 3,
    processCpuPercent,
    processPhysicalBytes,
    processPhysicalBytesGrowth: { chromiumRenderer: distribution(20 * 1024 * 1024) },
    longTaskMsPerMinute: distribution(100),
    revealMs: distribution(80, 120),
    firstCorrectFrameMs: distribution(120, 180),
    keystrokeToPaintMs: distribution(40, 70),
    keystrokeToPaintTimeouts: 0,
    attribution: { renderEvents: distribution(100) },
  };
  return {
    schema: 'o8/terminal-workload/v1',
    summary: { 1: summary, 12: structuredClone(summary) },
    samples: Array.from({ length: 3 }, () => ({
      sessionCount: 12,
      orchestratorLaunches: 0,
      correctness: { failures: 0, timeouts: 0 },
      diagnostics: { resyncUnsettledCount: 0, resyncFailedCount: 0 },
      rapidSwitch: { passed: true },
    })),
  };
}

describe('terminal workload locked budgets', () => {
  it('accepts a complete receipt below every ceiling', () => {
    expect(checkTerminalWorkloadBudgets(receipt())).toEqual([]);
  });

  it('enforces the strict N=12 realtime improvement gate', () => {
    const candidate = receipt();
    candidate.summary[12].processCpuPercent.realtimeServer = distribution(25, 30);
    expect(checkTerminalWorkloadBudgets(candidate)).toContain(
      'realtime-server CPU p50 25 must be below 25',
    );
  });

  it('rejects any sample with a resync barrier diagnostic', () => {
    const candidate = receipt();
    candidate.samples[1].diagnostics.resyncUnsettledCount = 1;
    expect(checkTerminalWorkloadBudgets(candidate)).toContain(
      'N=12 sample=unknown terminal_resync_unsettled diagnostics must be zero',
    );
  });

  it('rejects any sample that launched an orchestrator backend', () => {
    const candidate = receipt();
    candidate.samples[0].orchestratorLaunches = 1;
    expect(checkTerminalWorkloadBudgets(candidate)).toContain(
      'N=12 sample=unknown orchestrator launches must be zero, received 1',
    );
  });
});
