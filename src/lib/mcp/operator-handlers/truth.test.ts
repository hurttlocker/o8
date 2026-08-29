import { afterEach, describe, expect, it, vi } from 'vitest';

import { setApiBase } from './shared';
import { handleTruthQuery, TRUTH_TOOLS } from './truth';

function resultText(result: Awaited<ReturnType<typeof handleTruthQuery>>): string {
  const content = result.content[0];
  return content?.type === 'text' ? content.text : '';
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('o8 truth MCP handler', () => {
  it('publishes one flat strict-mode-safe schema', () => {
    expect(TRUTH_TOOLS).toEqual([expect.objectContaining({
      name: 'o8_truth_query',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['merged-since', 'packet', 'approvals'] },
          repo: expect.any(Object),
          since: expect.any(Object),
          packetId: expect.any(Object),
          issueNumber: expect.any(Object),
          limit: expect.any(Object),
        },
        required: ['kind'],
      },
    })]);
  });

  it('returns the truth route shape without wrapping it', async () => {
    setApiBase('http://127.0.0.1:41234');
    const payload = {
      query: { kind: 'packet', packetId: 'packet-a' },
      answers: [{
        summary: 'Packet packet-a merged.',
        receipt: { receiptId: 'receipt-a' },
        rawReceiptJson: '{"receiptId":"receipt-a"}\n',
        artifactId: 'artifact-a',
      }],
      asOf: '2026-08-29T20:00:00.000Z',
      nextCursor: null,
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain('/api/orchestrator/truth?');
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleTruthQuery({ kind: 'packet', packetId: 'packet-a', limit: 20 });

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(resultText(result))).toEqual(payload);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'http://127.0.0.1:41234/api/orchestrator/truth?kind=packet&limit=20&packetId=packet-a',
    );
  });

  it('rejects incompatible packet arguments before any request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleTruthQuery({
      kind: 'packet',
      packetId: 'packet-a',
      issueNumber: 1998,
    });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('exactly one of packetId or issueNumber');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
