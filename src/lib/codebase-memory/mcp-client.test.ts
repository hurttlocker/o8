import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  callCodebaseMemoryTool,
  withCodebaseMemoryToolSession,
  type McpToolCallResult,
} from './mcp-client';

const stubBin = resolve(process.cwd(), 'tests/fixtures/codebase-memory-mcp-stub.mjs');

function parsePayload(result: McpToolCallResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  const content = result.result as { content: Array<{ text: string }> };
  return JSON.parse(content.content[0].text) as {
    pid: number;
    callCount: number;
    toolName: string;
  };
}

describe('codebase-memory MCP transport', () => {
  it('reuses one initialized child for related tool calls', async () => {
    const session = await withCodebaseMemoryToolSession(
      { binPath: stubBin, cwd: process.cwd() },
      async (callTool) => [
        await callTool({ toolName: 'first' }),
        await callTool({ toolName: 'second' }),
      ],
    );

    expect(session.ok).toBe(true);
    if (!session.ok) throw new Error(session.error);
    const first = parsePayload(session.value[0]);
    const second = parsePayload(session.value[1]);
    expect(second.pid).toBe(first.pid);
    expect([first.callCount, second.callCount]).toEqual([1, 2]);
  });

  it('preserves the one-shot call adapter used by the indexer', async () => {
    const result = await callCodebaseMemoryTool({
      binPath: stubBin,
      cwd: process.cwd(),
      toolName: 'index_repo',
      timeoutMs: 1000,
    });

    expect(parsePayload(result)).toMatchObject({
      callCount: 1,
      toolName: 'index_repo',
    });
  });

  it('returns timeout and child-exit failures without leaking the process error', async () => {
    const timedOut = await withCodebaseMemoryToolSession(
      { binPath: stubBin, cwd: process.cwd() },
      (callTool) => callTool({ toolName: 'hang', timeoutMs: 25 }),
    );
    expect(timedOut.ok).toBe(true);
    if (!timedOut.ok) throw new Error(timedOut.error);
    expect(timedOut.value).toMatchObject({ ok: false });
    if (!timedOut.value.ok) expect(timedOut.value.error).toContain('timed out');

    const exited = await withCodebaseMemoryToolSession(
      { binPath: stubBin, cwd: process.cwd() },
      (callTool) => callTool({ toolName: 'exit', timeoutMs: 1000 }),
    );
    expect(exited.ok).toBe(true);
    if (!exited.ok) throw new Error(exited.error);
    expect(exited.value).toMatchObject({ ok: false });
    if (!exited.value.ok) expect(exited.value.error).toContain('Process exited');
  });
});
