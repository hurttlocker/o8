import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMission } from '../cli/src/commands/mission';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('mission status CLI timing receipt', () => {
  it('requests persisted timing and renders attempts, control, and autonomy', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      return new Response(JSON.stringify({
      ok: true,
      result: {
        missionId: 'mission-funnel-cli',
        packets: [{ id: 'packet-one', title: 'Do the work', status: 'released' }],
        funnel: {
          totalDurationMs: 62_000,
          terminalPacketCount: 1,
          attemptCount: 2,
          retryCount: 1,
          interventionCount: 1,
          recoveryEventCount: 0,
          strictAutonomousCloseCount: 0,
          governedAutonomousCloseCount: 0,
        },
      },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runMission({ human: true, verbose: false }, 'status', ['--mission', 'mission-funnel-cli']);

    const requested = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requested.pathname).toBe('/api/orchestrator/status');
    expect(requested.searchParams.get('includeTiming')).toBe('true');
    const output = vi.mocked(process.stdout.write).mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output).toContain('1m 2s · 1/1 terminal');
    expect(output).toContain('2 total · 1 retry');
    expect(output).toContain('1 interventions · 0 recoveries');
    expect(output).toContain('0 strict · 0 approval-only');
  });
});
