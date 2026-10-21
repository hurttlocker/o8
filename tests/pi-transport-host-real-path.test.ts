import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);

it('loads and streams both Pi transports through the CommonJS dev host', async () => {
  // A separate host is essential: the test runner's ESM loader masks this failure.
  const { stdout } = await execute(process.execPath, ['--import', 'tsx', '--input-type=commonjs', '--eval', `
    const { createManagedPiTransport } = require('./src/lib/pi/sdk/transport.ts');
    const { createOpenRouterPiTransport, openRouterPiModel, OpenRouterSpendCeiling } = require('./src/lib/pi/sdk/openrouter-transport.ts');
    const pricing = { inputPerMillion: 0.3, outputPerMillion: 1.2 };
    const model = openRouterPiModel('fixture/model', pricing, 64000);
    const context = { messages: [{ role: 'user', content: 'Say hello.', timestamp: 1 }] };
    const calls = [];
    const receipts = [];
    const fixtureFetch = async (url, init) => {
      calls.push({ url, model: JSON.parse(init.body).model, redirect: init.redirect });
      const chunks = [
        { id: 'fixture-1', object: 'chat.completion.chunk', created: 1, model: model.id,
          choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello.' }, finish_reason: null }] },
        { id: 'fixture-1', object: 'chat.completion.chunk', created: 1, model: model.id,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, cost: 0.000004 } },
      ];
      return new Response(chunks.map(chunk => 'data: ' + JSON.stringify(chunk) + '\\n\\n').join('') + 'data: [DONE]\\n\\n',
        { headers: { 'Content-Type': 'text/event-stream' } });
    };
    // Fail closed if either adapter bypasses the host-owned transport seam.
    globalThis.fetch = async () => { throw new Error('Unexpected external network call'); };
    const transports = [
      createManagedPiTransport({ model, fetch: fixtureFetch,
        resolveRoute: async () => ({ via: 'proxy', url: 'https://relay.invalid/inference', headers: {} }) }),
      createOpenRouterPiTransport({ model, pricing, fetch: fixtureFetch,
        ceiling: new OpenRouterSpendCeiling(1), resolveKey: async () => 'fixture-only',
        onReceipt: receipt => receipts.push(receipt) }),
    ];
    (async () => {
      const outcomes = [];
      for (const transport of transports) {
        const events = [];
        for await (const event of transport(context, new AbortController().signal)) events.push(event);
        outcomes.push({ done: events.some(event => event.type === 'done'),
          errors: events.filter(event => event.type === 'error'),
          text: events.filter(event => event.type === 'text_delta').map(event => event.delta).join('') });
      }
      console.log(JSON.stringify({ outcomes, calls, receipts }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: process.cwd(), timeout: 30_000, maxBuffer: 512 * 1024 });
  const result = JSON.parse(stdout.trim());
  expect(result.outcomes).toEqual([
    { done: true, errors: [], text: 'Hello.' },
    { done: true, errors: [], text: 'Hello.' },
  ]);
  expect(result.calls).toEqual([
    { url: 'https://relay.invalid/inference', model: 'fixture/model', redirect: 'error' },
    { url: 'https://openrouter.ai/api/v1/chat/completions', model: 'fixture/model', redirect: 'error' },
  ]);
  expect(result.receipts).toEqual([expect.objectContaining({ status: 'completed', costUsd: 0.000004 })]);
});
