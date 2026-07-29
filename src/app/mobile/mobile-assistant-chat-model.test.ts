/**
 * Real-path test for the mobile chat model — driven through `run()`, the generator the
 * assistant-ui runtime actually consumes, with a stubbed fetch standing in for the proxy.
 *
 * The live bug (2026-07-29): the proxy's `error` events had no case in
 * normalizeStreamPayload, so a runtime that failed for a stated reason was dropped on the
 * floor and the surface printed "No response received." — a dead end for the operator.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMobileChatModel } from './mobile-assistant-chat-model';
import type { ModelOption } from './mobile-approvals-shared';

const CODEX_MODEL: ModelOption = {
  id: 'gpt-5.6-sol',
  label: 'GPT-5.6 Sol',
  provider: 'openai',
  description: 'Codex CLI',
  backend: 'cli',
  cliRuntime: 'codex',
  defaultEffort: 'low',
};

function sseResponse(...events: Record<string, unknown>[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function runToEnd(response: Response) {
  vi.stubGlobal('fetch', vi.fn(async () => response));
  const model = createMobileChatModel(CODEX_MODEL, '/tmp/repo');
  const controller = new AbortController();
  const results: unknown[] = [];
  const stream = model.run({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    abortSignal: controller.signal,
  } as never) as AsyncGenerator<unknown>;
  for await (const chunk of stream) {
    results.push(chunk);
  }
  return results;
}

function textOf(chunk: unknown): string {
  const content = (chunk as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('');
}

describe('mobile chat model — runtime errors reach the operator', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the reason a runtime gave instead of "No response received."', async () => {
    const reason = 'Codex exited without a response (exit code 1) in /Users/q/repo.\nNot inside a trusted directory.';
    const chunks = await runToEnd(sseResponse({ type: 'error', message: reason, text: reason }, { type: 'done' }));

    const last = chunks.at(-1) as { status?: { type: string; reason?: string; error?: string } };
    expect(textOf(last)).toBe(reason);
    expect(last.status?.type).toBe('incomplete');
    expect(last.status?.error).toBe(reason);
    expect(chunks.map(textOf).join('')).not.toContain('No response received.');
  });

  it('still reports a truly empty stream as no response', async () => {
    const chunks = await runToEnd(sseResponse({ type: 'done' }));
    expect(textOf(chunks.at(-1))).toBe('No response received.');
  });

  it('keeps content when the runtime answers', async () => {
    const chunks = await runToEnd(sseResponse({ type: 'content', text: 'pong' }, { type: 'done' }));
    expect(chunks.map(textOf).join('')).toContain('pong');
  });
});
