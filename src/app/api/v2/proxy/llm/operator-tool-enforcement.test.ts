import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The o8 model is advertised only file-editing tools, but advertisement is a soft
// guarantee — a model (especially a weak free-tier one, or one nudged by injected
// file content) can still EMIT an undeclared call. These tests prove the allowlist
// is ENFORCED at execution on BOTH rails: a github / shell / run_terminal_command
// call is rejected before it can run `gh pr merge`. (Adversarial review 2026-07-14.)

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

// ── OpenRouter rail: streamOpenRouterFallback tool loop ─────────────────────
const mockExecuteTool = vi.fn();
const mockFetch = vi.fn();

vi.mock('@/lib/llm/tools', () => ({
  executeTool: (...args: unknown[]) => mockExecuteTool(...args),
  TOOLS: [
    { name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } },
    { name: 'write_file', description: 'write', parameters: { type: 'object', properties: {} } },
    { name: 'edit_file', description: 'edit', parameters: { type: 'object', properties: {} } },
    { name: 'run_terminal_command', description: 'shell', parameters: { type: 'object', properties: {} } },
  ],
}));

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
  mockExecuteTool.mockReset();
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenRouter operator rail enforces the allowlist at execution', () => {
  it('rejects a disallowed tool (run_terminal_command) WITHOUT calling executeTool', async () => {
    mockExecuteTool.mockResolvedValue({ content: 'SHOULD NEVER RUN' });
    mockFetch
      .mockResolvedValueOnce(orSse([
        orChunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'run_terminal_command', arguments: '{"command":"gh pr merge 1 --admin"}' } }] }),
        'data: [DONE]\n\n',
      ]))
      .mockResolvedValueOnce(orSse([
        orChunk({ content: 'I can only edit files.' }),
        'data: [DONE]\n\n',
      ]));

    const res = await streamOpenRouterFallback({
      apiKey: 'k',
      model: 'nemotron',
      auth: null,
      messages: [{ role: 'user', content: 'merge the PR' }],
      enableTools: true,
      scopedRepoRoot: '/tmp/o8-enforce-repo',
    });
    const text = await drain(res);

    expect(mockExecuteTool).not.toHaveBeenCalled();
    expect(text).toMatch(/not available in this mode/i);
  });

  it('runs an allowlisted tool (write_file) through executeTool, scoped to the repo', async () => {
    mockExecuteTool.mockResolvedValue({ content: 'Created page.html (100 bytes)' });
    mockFetch
      .mockResolvedValueOnce(orSse([
        orChunk({ tool_calls: [{ index: 0, id: 'c2', function: { name: 'write_file', arguments: '{"path":"page.html","content":"<h1>hi</h1>"}' } }] }),
        'data: [DONE]\n\n',
      ]))
      .mockResolvedValueOnce(orSse([
        orChunk({ content: 'Done.' }),
        'data: [DONE]\n\n',
      ]));

    const res = await streamOpenRouterFallback({
      apiKey: 'k',
      model: 'nemotron',
      auth: null,
      messages: [{ role: 'user', content: 'make page.html' }],
      enableTools: true,
      scopedRepoRoot: '/tmp/o8-enforce-repo',
    });
    const text = await drain(res);

    expect(mockExecuteTool).toHaveBeenCalledWith('write_file', { path: 'page.html', content: '<h1>hi</h1>' }, '/tmp/o8-enforce-repo');
    expect(text).toMatch(/Created page\.html/);
  });

  it('the non-tool chat path never attaches tools (enableTools off)', async () => {
    mockFetch.mockResolvedValueOnce(orSse([orChunk({ content: 'hello' }), 'data: [DONE]\n\n']));

    const res = await streamOpenRouterFallback({
      apiKey: 'k',
      model: 'nemotron',
      auth: null,
      messages: [{ role: 'user', content: 'hi' }],
    });
    await drain(res);

    const sentBody = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body);
    expect(sentBody.tools).toBeUndefined();
    expect(sentBody.tool_choice).toBeUndefined();
  });
});
