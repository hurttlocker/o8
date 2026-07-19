import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  callTool: vi.fn(),
  resolveCodebaseMemoryBin: vi.fn(() => '/tmp/codebase-memory-mcp'),
  withCodebaseMemoryToolSession: vi.fn(),
}));

vi.mock('./binary', () => ({
  resolveCodebaseMemoryBin: mocks.resolveCodebaseMemoryBin,
}));

vi.mock('./mcp-client', () => ({
  withCodebaseMemoryToolSession: mocks.withCodebaseMemoryToolSession,
}));

import { traceSymbols } from './client';

function toolResult(payload: unknown) {
  return {
    ok: true as const,
    result: {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
    },
    durationMs: 1,
  };
}

describe('traceSymbols', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveCodebaseMemoryBin.mockReturnValue('/tmp/codebase-memory-mcp');
    mocks.callTool.mockImplementation(async (input: { toolName: string; args?: Record<string, unknown> }) => {
      const symbol = String(input.args?.function_name ?? input.args?.query ?? '');
      if (input.toolName === 'trace_path') {
        return toolResult({ callers: [{ name: `${symbol}Caller` }] });
      }
      return toolResult({
        total: 1,
        results: [{
          name: symbol,
          label: 'Function',
          file_path: `src/${symbol}.ts`,
          start_line: 12,
        }],
      });
    });
    mocks.withCodebaseMemoryToolSession.mockImplementation(async (_input, run) => {
      const value = await run(mocks.callTool);
      return { ok: true, value, durationMs: 1 };
    });
  });

  it('shares one session and stops after the requested resolved symbols', async () => {
    const result = await traceSymbols({
      repoPath: '/tmp/repo',
      symbols: ['alphaSymbol', 'bravoSymbol', 'charlieSymbol', 'deltaSymbol'],
      resolvedLimit: 3,
    });

    expect(result.unavailable).toBe(false);
    expect(result.edges.map((edge) => edge.symbol)).toEqual([
      'alphaSymbol',
      'bravoSymbol',
      'charlieSymbol',
    ]);
    expect(mocks.withCodebaseMemoryToolSession).toHaveBeenCalledTimes(1);
    expect(mocks.callTool).toHaveBeenCalledTimes(6);
    expect(mocks.callTool.mock.calls.map(([input]) => input.toolName)).toEqual([
      'trace_path',
      'search_graph',
      'trace_path',
      'search_graph',
      'trace_path',
      'search_graph',
    ]);
  });

  it('degrades a session initialization failure into trace-error edges', async () => {
    mocks.withCodebaseMemoryToolSession.mockResolvedValue({
      ok: false,
      error: 'initialize failed',
      durationMs: 1,
    });

    const result = await traceSymbols({
      repoPath: '/tmp/repo',
      symbols: ['alphaSymbol'],
    });

    expect(result.edges).toEqual([{
      symbol: 'alphaSymbol',
      neighbours: [],
      error: 'initialize failed',
      reason: 'trace-error',
    }]);
  });
});
