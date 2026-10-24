import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createPiOrchestratorBackend } from '@/lib/lane/orchestrator-backends/pi';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import { createPiSdkSession } from '@/lib/pi/sdk/session';
import { createOpenRouterPiTransport, openRouterPiModel, OpenRouterSpendCeiling, type OpenRouterPiReceipt } from '@/lib/pi/sdk/openrouter-transport';

import { recordPiOpenRouterReceipt } from '@/lib/pi/openrouter-choice';
import { closeDb, getDb, usageLogs } from '@/lib/db';

const roots: string[] = [];
afterAll(() => closeDb());
const sessions: Awaited<ReturnType<typeof createPiSdkSession>>[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(sessions.splice(0).map(session => session.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(modelId: string, useTool = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'o8-prompt-cache-'))); roots.push(root);
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  await writeFile(join(workspace, 'receipt.txt'), 'persisted tool result');
  const bodies: Record<string, unknown>[] = [];
  const receipts: OpenRouterPiReceipt[] = [];
  const pricing = { inputPerMillion: 1, outputPerMillion: 1 };
  const model = openRouterPiModel(modelId, pricing);
  const ceiling = new OpenRouterSpendCeiling(1);
  let turnCalls = 0;
  const cachedPrefixes = new Set<string>();
  const transport = createOpenRouterPiTransport({ model, pricing, ceiling, cacheRefreshMs: 20,
    resolveKey: async () => 'fixture-only', onReceipt: receipt => {
      receipts.push(receipt);
      recordPiOpenRouterReceipt(receipt, { role: 'worker', agentName: 'pi-cache-fixture', sessionKey: root });
    },
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      const warm = body.max_tokens === 1;
      const callTool = useTool && !warm && ++turnCalls === 1;
      const key = typeof body.prompt_cache_key === 'string' ? body.prompt_cache_key : '';
      const hit = Boolean(key && cachedPrefixes.has(key));
      if (key) cachedPrefixes.add(key);
      // Protocol replay with deterministic cold/warm delays, not a live latency claim.
      await new Promise(resolve => setTimeout(resolve, hit ? 2 : 30));
      const chunk = { id: `${root}-${bodies.length}`, object: 'chat.completion.chunk', created: 1, model: modelId,
        choices: [{ index: 0, delta: callTool
          ? { tool_calls: [{ index: 0, id: 'read-1', type: 'function', function: { name: 'slow_read', arguments: '{}' } }] }
          : { content: warm ? 'WARM_OUTPUT' : 'Finished' }, finish_reason: callTool ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 4000, completion_tokens: 1, cost: 0.001,
          prompt_tokens_details: { cached_tokens: hit ? 3900 : 0, cache_write_tokens: key && !hit ? 4000 : 0 } } };
      return new Response('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  const session = await createPiSdkSession({ workspace, stateDir: join(root, 'state'), model, transport,
    systemPrompt: 'Stable project instructions. '.repeat(600),
    hostTools: [{ definition: { name: 'slow_read', description: 'Read a persisted result',
      parameters: { type: 'object', properties: {}, additionalProperties: false } },
    execute: async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return { content: [{ type: 'text', text: await readFile(join(workspace, 'receipt.txt'), 'utf8') }] };
    } }],
  });
  sessions.push(session);
  return { session, bodies, receipts, ceiling, root, workspace, transport, model, pricing };
}

describe('API prompt cache lifecycle through the real Pi worker', () => {
  it.each(['openai/gpt-6-sol', 'anthropic/claude-sonnet-4.6'])('warms the stable prefix and refreshes during a tool on %s', async model => {
    vi.stubEnv('O8_PROMPT_CACHE_WARMING', 'off');
    const baseline = await fixture(model);
    await baseline.session.prompt('Read the receipt');
    vi.unstubAllEnvs();
    const { session, bodies, receipts, ceiling, root } = await fixture(model);
    const result = await session.prompt('Read the receipt');
    expect(result.text).toBe('Finished');
    expect(receipts.filter(receipt => receipt.purpose === 'prewarm')).toHaveLength(1);
    expect(receipts.filter(receipt => receipt.purpose === 'keepalive')).toHaveLength(2);
    expect(receipts.filter(receipt => receipt.purpose === 'turn')).toHaveLength(2);
    expect(ceiling.spentUsd).toBeCloseTo(0.005);
    const warm = bodies.filter(body => body.max_tokens === 1);
    expect(warm).toHaveLength(3);
    expect(warm.every(body => body.tool_choice === 'none')).toBe(true);
    expect(warm.every(body => !JSON.stringify(body).includes('Read the receipt'))).toBe(true);
    expect(new Set(bodies.map(body => body.prompt_cache_key)).size).toBe(1);
    const persisted = await readFile(session.sessionFile, 'utf8');
    expect(persisted).toContain('persisted tool result');
    expect(persisted).not.toContain('WARM_OUTPUT');
    const rows = getDb()!.select().from(usageLogs).all().filter(row => row.sessionKey === root);
    expect(rows).toHaveLength(5);
    expect(rows[0].cacheWriteTokens).toBe(4000);
    expect(rows.slice(1).every(row => row.cacheWriteTokens === 0 && row.cacheReadTokens === 3900)).toBe(true);
    expect(rows.map(row => JSON.parse(row.metadataJson!).purpose)).toEqual(receipts.map(receipt => receipt.purpose));
    expect(JSON.parse(rows[0].metadataJson!).cachedTokenRatio).toBe(0);
    expect(rows.slice(1).every(row => JSON.parse(row.metadataJson!).cachedTokenRatio === 0.975)).toBe(true);
    expect(rows.every(row => typeof JSON.parse(row.metadataJson!).timeToFirstTokenMs === 'number')).toBe(true);
    process.stdout.write('[prompt-cache protocol fixture] ' + JSON.stringify({ model,
      before: baseline.receipts.map(receipt => ({ ttftMs: receipt.timeToFirstTokenMs, cachedRatio: receipt.cachedTokenRatio })),
      after: receipts.filter(receipt => receipt.purpose === 'turn').map(receipt => ({ ttftMs: receipt.timeToFirstTokenMs, cachedRatio: receipt.cachedTokenRatio })),
    }) + '\n');
    const count = receipts.length;
    await new Promise(resolve => setTimeout(resolve, 70));
    expect(receipts).toHaveLength(count);
  }, 20_000);

  it('honors the host opt-out and preserves ordinary tool calls', async () => {
    vi.stubEnv('O8_PROMPT_CACHE_WARMING', 'off');
    const { session, bodies, receipts } = await fixture('openai/gpt-6-sol');
    expect((await session.prompt('Read the receipt')).text).toBe('Finished');
    expect(receipts.map(receipt => receipt.purpose)).toEqual(['turn', 'turn']);
    expect(bodies.every(body => !body.prompt_cache_options)).toBe(true);
  }, 20_000);

  it('reaches the same cache lifecycle through the orchestrator sendTurn adapter', async () => {
    const f = await fixture('openai/gpt-6-sol', false);
    await f.session.close();
    const backend = createPiOrchestratorBackend({ transport: f.transport,
      stateRoot: () => join(f.root, 'lead'),
      openServers: async () => ({ servers: [], close: async () => {} }),
      resolveRoute: async () => ({ carrier: 'openrouter', model: f.model, pricing: f.pricing,
        choice: 'openrouter/' + f.model.id, label: 'Fixture model' }),
    });
    const events: OrchestratorEvent[] = [];
    try {
      await backend.sendTurn(f.workspace, 'Answer briefly', event => events.push(event), { model: 'openrouter/' + f.model.id });
      expect(events.some(event => event.type === 'error')).toBe(false);
      expect(events.some(event => event.type === 'done')).toBe(true);
      expect(f.receipts.map(receipt => receipt.purpose)).toEqual(['prewarm', 'turn']);
      expect(new Set(f.bodies.map(body => body.prompt_cache_key)).size).toBe(1);
      expect(await backend.hasSession?.(f.workspace)).toBe(true);
    } finally { await backend.closeAll?.(); }
  }, 20_000);

});
