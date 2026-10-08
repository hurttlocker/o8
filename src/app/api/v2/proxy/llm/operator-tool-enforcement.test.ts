import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A caller's tool allowlist is advertisement AND enforcement on the Gemini rail: a
// model can still EMIT an undeclared call, and it must be rejected before it can
// run `gh pr merge`. (Adversarial review 2026-07-14.) The operator rail itself is
// text only since #3408; its OpenRouter path below never attaches or runs tools.

// ── Gemini rail: executeNativeTool ──────────────────────────────────────────
import { executeNativeTool } from './google-native-execution';

describe('executeNativeTool enforces the allowlist at execution', () => {
  const opts = {
    model: 'gemini',
    repoRoot: '/tmp/o8-enforce-repo',
    tabId: 't',
    allowedTools: ['read_file', 'create_file', 'edit_file'],
  };

  it('rejects github (pr merge) even though the model emitted it', async () => {
    const result = await executeNativeTool('github', { subcommand: 'pr merge 1 --admin' }, opts);
    expect(result.status).toBe('error');
    expect(result.output).toMatch(/not available in this mode/i);
  });

  it('rejects shell even though the model emitted it', async () => {
    const result = await executeNativeTool('shell', { command: 'gh pr merge 1' }, opts);
    expect(result.status).toBe('error');
    expect(result.output).toMatch(/not available in this mode/i);
  });

  it('lets an allowlisted tool through to the real executor (not the allowlist rejection)', async () => {
    const result = await executeNativeTool('read_file', { file_path: 'nope.txt' }, opts);
    // read_file passed the gate and actually ran (file-not-found), so the output
    // is NOT the allowlist rejection message.
    expect(result.output).not.toMatch(/not available in this mode/i);
  });

  it('with no allowlist, behaves as before (github reaches its executor)', async () => {
    const result = await executeNativeTool('github', { subcommand: 'pr list' }, { model: 'g', repoRoot: '/tmp/o8-enforce-repo', tabId: 't' });
    // No allowlist → not short-circuited by the gate (it reaches executeGithub,
    // which will error on its own, but never the allowlist message).
    expect(result.output).not.toMatch(/not available in this mode/i);
  });
});

// ── OpenRouter rail: text only since #3408 ──────────────────────────────────
const mockFetch = vi.fn();

import { streamOpenRouterFallback } from './operator-fallback';

function orSse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return { ok: true, body } as unknown as Response;
}

function orChunk(delta: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
}

async function drain(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenRouter operator rail is text only', () => {
  it('never attaches tools, and a tool call the model emits anyway is not run', async () => {
    mockFetch.mockResolvedValueOnce(orSse([
      orChunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_file', arguments: '{"path":"page.html","content":"x"}' } }] }),
      orChunk({ content: 'hello' }),
      'data: [DONE]\n\n',
    ]));

    const res = await streamOpenRouterFallback({
      apiKey: 'k',
      model: 'nemotron',
      auth: null,
      messages: [{ role: 'user', content: 'make page.html' }],
    });
    const text = await drain(res);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body);
    expect(sentBody.tools).toBeUndefined();
    expect(sentBody.tool_choice).toBeUndefined();
    expect(text).toContain('hello');
    expect(text).not.toMatch(/tool_use|tool_result/);
  });
});
