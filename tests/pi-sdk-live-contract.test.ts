import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { O8_MANAGED_FLASH_LITE_CONTRACT, O8_MANAGED_FLASH_LITE_MODEL } from '@/lib/pi/sdk/live-contract';
import { initializePiTestBudget, maximumPiRequestCost, readPiTestBudget, validatePiBillingContract } from '@/lib/pi/sdk/test-budget';
import { createBudgetedPiTestTransport, resolveLivePiTestContract } from '@/lib/pi/sdk/test-transport';

// Fields api.o8.run/v1/inference accepts, plus the three it strips first.
const SERVER_FIELDS = new Set(['model', 'messages', 'max_tokens', 'stream', 'temperature', 'top_p',
  'tools', 'tool_choice', 'response_format', 'stop', 'stream_options', 'usage']);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('verified managed Pi live contract', () => {
  it('is the live default and bounds every request at 17,696 micro-USD', async () => {
    const live = await resolveLivePiTestContract();
    expect(live).toEqual(O8_MANAGED_FLASH_LITE_CONTRACT);
    expect(() => validatePiBillingContract(live!)).not.toThrow();
    expect(maximumPiRequestCost(live!)).toBe(17_696);
    expect(maximumPiRequestCost(live!) * live!.maxCalls).toBeLessThan(1_000_000);
    expect(O8_MANAGED_FLASH_LITE_MODEL.id).toBe(live!.modelId);
    expect(O8_MANAGED_FLASH_LITE_MODEL.contextWindow).toBe(live!.contextWindow);
  });

  it('sends only server-accepted fields through the guarded transport, offline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'o8-pi-live-contract-')); roots.push(root);
    const workspace = join(root, 'workspace'); await mkdir(workspace);
    const ledgerPath = join(root, 'budget.sqlite');
    initializePiTestBudget(ledgerPath, 1_000_000, O8_MANAGED_FLASH_LITE_CONTRACT);
    let body: Record<string, unknown> | undefined;
    const transport = createBudgetedPiTestTransport({
      model: O8_MANAGED_FLASH_LITE_MODEL, ledgerPath, workspace,
      resolveRoute: async () => ({ via: 'proxy' as const, url: O8_MANAGED_FLASH_LITE_CONTRACT.endpoint, headers: { Authorization: 'Bearer synthetic-secret' } }),
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const context = {
      systemPrompt: 'Synthetic system prompt.',
      messages: [{ role: 'user' as const, content: 'hello', timestamp: Date.now() }],
      tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
    };
    for await (const event of transport(context as never, new AbortController().signal)) void event;

    expect(body).toBeDefined();
    expect(Object.keys(body!).filter(key => !SERVER_FIELDS.has(key))).toEqual([]);
    expect(body!.model).toBe('google/gemini-2.5-flash-lite');
    expect(body!.max_tokens).toBe(4_096);
    expect(body!).not.toHaveProperty('store');
    expect(body!).not.toHaveProperty('max_completion_tokens');
    expect((body!.messages as Array<{ role: string }>)[0].role).toBe('system');
    expect(readPiTestBudget(ledgerPath)).toMatchObject({ calls: 1, pending: 0, unknown: 0, reservedMicroUsd: 17_696 });
  });
});
