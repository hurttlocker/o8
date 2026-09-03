import { describe, expect, it } from 'vitest';
import {
  summarizeBrowserPerformanceEntries,
  targetFromPanelStatus,
} from '../scripts/bench/measure-browser-boot.mjs';
import { summarizeQuickScorecard } from '../scripts/bench/quick.mjs';

describe('quick benchmark receipts', () => {
  it('counts only API boot requests and reports the largest client queue stall', () => {
    expect(summarizeBrowserPerformanceEntries([
      { name: 'http://127.0.0.1:47120/_next/app.js', fetchStart: 5, requestStart: 7 },
      { name: 'http://127.0.0.1:47120/api/runtime/inventory', fetchStart: 10, requestStart: 44.4 },
      { name: 'http://127.0.0.1:47120/api/panel/repos', fetchStart: 12, requestStart: 18 },
    ])).toEqual({
      bootApiRequestCount: 2,
      maxClientQueueStallMs: 34.4,
    });
  });

  it('classifies regressions and missing measurements independently', () => {
    const summary = summarizeQuickScorecard({
      tracks: {
        speed: {
          metrics: {
            time_to_reveal_ms: { value: 1_500, delta: 'regressed', deltaValue: 200 },
            panel_branches_ms: { value: null, delta: 'missing' },
            runtime_inventory_ms: { value: 80, delta: 'unchanged' },
          },
        },
      },
    });

    expect(summary.status).toBe('regressed');
    expect(summary.regressions).toEqual([{ name: 'time_to_reveal_ms', deltaValue: 200 }]);
    expect(summary.missing).toEqual(['panel_branches_ms']);
  });

  it('keeps the running target identity separate from the benchmark checkout', () => {
    expect(targetFromPanelStatus({
      version: '0.1.729',
      buildGitSha: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
      buildMode: 'packaged',
      platform: 'darwin',
    })).toEqual({
      appVersion: '0.1.729',
      buildGitSha: 'abcdef0123456789abcdef0123456789abcdef01',
      buildMode: 'packaged',
      platform: 'darwin',
      unavailableReason: null,
    });
  });

  it('reports missing target fields instead of substituting the source checkout', () => {
    expect(targetFromPanelStatus({ version: '0.1.728', platform: 'darwin' })).toEqual({
      appVersion: '0.1.728',
      buildGitSha: null,
      buildMode: null,
      platform: 'darwin',
      unavailableReason: 'build Git SHA, build mode unavailable from running target',
    });
  });
});
