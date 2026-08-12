import { afterEach, describe, expect, it, vi } from 'vitest';

const { getMissionStatus } = await import('@/lib/mcp/operator-mission-tools');

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('MCP mission funnel forwarding', () => {
  it('forwards includeTiming to the shared status route', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      return new Response(JSON.stringify({
        ok: true,
        result: { missionId: 'mission-one', packets: [], funnel: { schemaVersion: 1 } },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await getMissionStatus({ missionId: 'mission-one', includeCost: true, includeTiming: true });

    const requested = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requested.pathname).toBe('/api/orchestrator/status');
    expect(requested.searchParams.get('missionId')).toBe('mission-one');
    expect(requested.searchParams.get('includeCost')).toBe('true');
    expect(requested.searchParams.get('includeTiming')).toBe('true');
  });
});
