import { afterEach, describe, expect, it, vi } from 'vitest';

import { runHistory } from './history';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.O8_API_PORT;
});

describe('o8 history', () => {
  it('prints one continuous timeline with its audited handoff seam', async () => {
    process.env.O8_API_PORT = '47120';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      schema: 'o8/orchestrator.history/v1',
      ok: true,
      thread: { id: 'thoughts-cli-history', title: null, repoPath: '/repo', modifiedAt: '2026-08-26T12:00:00.000Z' },
      count: 3,
      truncated: false,
      timeline: [
        { kind: 'message', id: 'u1', timestamp: 1, role: 'user', content: 'Start.', backend: null, model: null, handoff: null, audits: [] },
        {
          kind: 'handoff',
          id: 'h1',
          timestamp: 2,
          role: 'system',
          content: 'handoff',
          backend: null,
          model: null,
          handoff: {
            from: { backend: 'claude', model: 'source/model' },
            to: { backend: 'codex', model: 'destination/model' },
            lossless: false,
            carries: { narrative: 'full', intent: 'summary', workspace: 'full', governance: 'omitted', provenance: 'summary' },
          },
          audits: [{ laneId: 'lane-1', packetId: 'packet-1' }],
        },
        { kind: 'message', id: 'a1', timestamp: 3, role: 'assistant', content: 'Continued.', backend: 'codex', model: 'destination/model', handoff: null, audits: [] },
      ],
    }), { status: 200 })));
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    await expect(runHistory({ human: false, verbose: false }, ['thoughts-cli-history'])).resolves.toBe(0);
    const payload = JSON.parse(writes.join('')) as { schema: string; timeline: Array<{ kind: string; audits: unknown[] }> };
    expect(payload.schema).toBe('o8/cli/history/v1');
    expect(payload.timeline).toContainEqual(expect.objectContaining({ kind: 'handoff', audits: [expect.any(Object)] }));
  });
});
