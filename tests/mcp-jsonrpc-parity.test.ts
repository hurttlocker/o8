import { describe, expect, it } from 'vitest';
import { compareMcpExchanges, type McpExchange } from '../scripts/lib/mcp-parity';

function exchange(data: unknown): McpExchange {
  return { status: 200, headers: { 'content-type': 'application/json' }, body: {
    jsonrpc: '2.0', id: 0, result: { content: [{ type: 'text', text: JSON.stringify(data) }], isError: false },
  } };
}

describe('recorded MCP response comparison', () => {
  it('compares nested text JSON field by field independently of object key order', () => {
    expect(() => compareMcpExchanges(exchange({ count: 1, tasks: [{ id: 'a', status: 'running' }] }),
      exchange({ tasks: [{ status: 'running', id: 'a' }], count: 1 }))).not.toThrow();
  });
  it.each([
    [{ count: 1 }, { count: 2 }],
    [{ tasks: [{ id: 'a' }, { id: 'b' }] }, { tasks: [{ id: 'b' }, { id: 'a' }] }],
    [{ tasks: [] }, { tasks: [{}] }],
    [{ count: 1 }, { count: 1, extra: false }],
    [{ checkedAt: 1 }, {}],
  ])('rejects changed, reordered, extra or missing fields', (left, right) => {
    expect(() => compareMcpExchanges(exchange(left), exchange(right))).toThrow('mismatch');
  });
  it('permits only an explicit freshness field, retaining presence and type checks', () => {
    const pointer = '/body/result/content/0/text/json/checkedAt';
    expect(() => compareMcpExchanges(exchange({ checkedAt: 1 }), exchange({ checkedAt: 2 }))).toThrow();
    expect(() => compareMcpExchanges(exchange({ checkedAt: 1 }), exchange({ checkedAt: 2 }), [pointer])).not.toThrow();
    expect(() => compareMcpExchanges(exchange({ checkedAt: 1 }), exchange({ checkedAt: '2' }), [pointer])).toThrow();
    expect(() => compareMcpExchanges(exchange({ checkedAt: 1 }), exchange({}), [pointer])).toThrow();
    expect(() => compareMcpExchanges(exchange({ count: 1 }), exchange({ count: 2 }), [pointer.replace('checkedAt', 'count')])).toThrow('Invalid freshness');
  });
  it('compares status, headers, JSON-RPC ids and plain error text', () => {
    const reference = exchange({ count: 0 });
    for (const candidate of [{ ...reference, status: 401 }, { ...reference, headers: {} },
      { ...reference, body: { jsonrpc: '2.0', id: 1, result: {} } }]) {
      expect(() => compareMcpExchanges(reference, candidate)).toThrow('mismatch');
    }
  });
});
