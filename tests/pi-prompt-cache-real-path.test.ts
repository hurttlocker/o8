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

vi.mock('@/lib/cortex/qa/llm/byok-keys', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/cortex/qa/llm/byok-keys')>(),
  resolveOpenRouterKey: async () => 'fixture-only',
}));

const roots: string[] = [];
afterAll(() => closeDb());
const sessions: Awaited<ReturnType<typeof createPiSdkSession>>[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(sessions.splice(0).map(session => session.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(modelId: string, useTool = true, warmGate?: Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'o8-prompt-cache-'))); roots.push(root);
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  await writeFile(join(workspace, 'receipt.txt'), 'persisted tool result');
  const bodies: Record<string, unknown>[] = [];
  const receipts: OpenRouterPiReceipt[] = [];
  const events: Record<string, unknown>[] = [];
  const pricing = { inputPerMillion: 1, outputPerMillion: 1 };
  const model = openRouterPiModel(modelId, pricing);
  const ceiling = new OpenRouterSpendCeiling(1);
  let requestCount = 0;
  let turnCalls = 0;
  const cachedPrefixes = new Set<string>();
  let warmed!: () => void;
  const warmFinished = new Promise<void>(resolve => { warmed = resolve; });
  const fixtureFetch: typeof fetch = async (_url, init) => {
    const requestId = ++requestCount;
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    const warm = body.max_tokens === 1;
    if (warm && warmGate) {
      const signal = init!.signal!;
      await new Promise<void>((resolve, reject) => {
        const stop = () => reject(new Error('Stopped'));
        signal.addEventListener('abort', stop, { once: true });
        void warmGate.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
      });
    }
    const callTool = useTool && !warm && ++turnCalls === 1;
    const key = typeof body.prompt_cache_key === 'string' ? body.prompt_cache_key : '';
    const hit = Boolean(key && cachedPrefixes.has(key));
    if (key) cachedPrefixes.add(key);
    // Protocol replay with deterministic cold/warm delays, not a live latency claim.
    await new Promise(resolve => setTimeout(resolve, hit ? 2 : 30));
    const chunk = { id: `${root}-${requestId}`, object: 'chat.completion.chunk', created: 1, model: modelId,
      choices: [{ index: 0, delta: callTool
        ? { tool_calls: [{ index: 0, id: 'read-1', type: 'function', function: { name: 'slow_read', arguments: '{}' } }] }
        : { content: warm ? 'WARM_OUTPUT' : 'Finished' }, finish_reason: callTool ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 4000, completion_tokens: 1, cost: 0.001,
        prompt_tokens_details: { cached_tokens: hit ? 3900 : 0, cache_write_tokens: key && !hit ? 4000 : 0 } } };
    return new Response('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const transport = createOpenRouterPiTransport({ model, pricing, ceiling, fetch: fixtureFetch,
    resolveKey: async () => 'fixture-only', onReceipt: receipt => {
      receipts.push(receipt);
      recordPiOpenRouterReceipt(receipt, { role: 'worker', agentName: 'pi-cache-fixture', sessionKey: root });
      if (receipt.purpose === 'prewarm') warmed();
    },
  });
  const prepare = vi.spyOn(transport, 'prepare');
  const session = await createPiSdkSession({ workspace, stateDir: join(root, 'state'), model, transport,
    onEvent: event => events.push(event),
    systemPrompt: 'Stable project instructions. '.repeat(600),
    hostTools: [{ definition: { name: 'slow_read', description: 'Read a persisted result',
      parameters: { type: 'object', properties: {}, additionalProperties: false } },
    execute: async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return { content: [{ type: 'text', text: await readFile(join(workspace, 'receipt.txt'), 'utf8') }] };
    } }],
  });
  sessions.push(session);
  return { session, bodies, receipts, ceiling, root, workspace, transport, model, pricing, prepare, warmFinished, events, fixtureFetch };
}

describe('API prompt cache lifecycle through the real Pi worker', () => {
  it.each(['openai/gpt-6-sol', 'anthropic/claude-sonnet-4.6'])('prewarms once before two prompts on one session on %s', async model => {
    const { session, bodies, receipts, ceiling, root, prepare, warmFinished } = await fixture(model);
    await vi.waitFor(() => expect(receipts.map(receipt => receipt.purpose)).toEqual(['prewarm']));
    await warmFinished;
    expect(bodies).toHaveLength(1);
    expect(prepare).toHaveBeenCalledTimes(1);
    // A settled session prewarm must never be restarted or waited on per run.
    prepare.mockImplementation(() => new Promise(() => {}));
    const result = await session.prompt('Read the receipt');
    expect(result.text).toBe('Finished');
    expect((await session.prompt('Answer again')).text).toBe('Finished');
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(receipts.filter(receipt => receipt.purpose === 'prewarm')).toHaveLength(1);
    expect(receipts.filter(receipt => receipt.purpose === 'keepalive')).toHaveLength(0);
    expect(receipts.filter(receipt => receipt.purpose === 'turn')).toHaveLength(3);
    expect(ceiling.spentUsd).toBeCloseTo(0.004);
    const warm = bodies.filter(body => body.max_tokens === 1);
    expect(warm).toHaveLength(1);
    expect(warm.every(body => body.tool_choice === 'none')).toBe(true);
    expect(warm.every(body => !JSON.stringify(body).includes('Read the receipt'))).toBe(true);
    expect(new Set(bodies.map(body => body.prompt_cache_key)).size).toBe(1);
    const persisted = await readFile(session.sessionFile, 'utf8');
    expect(persisted).toContain('persisted tool result');
    expect(persisted).not.toContain('WARM_OUTPUT');
    const rows = getDb()!.select().from(usageLogs).all().filter(row => row.sessionKey === root);
    expect(rows).toHaveLength(4);
    expect(rows[0].cacheWriteTokens).toBe(4000);
    expect(rows.slice(1).every(row => row.cacheWriteTokens === 0 && row.cacheReadTokens === 3900)).toBe(true);
    expect(rows.map(row => JSON.parse(row.metadataJson!).purpose)).toEqual(receipts.map(receipt => receipt.purpose));
    expect(JSON.parse(rows[0].metadataJson!).cachedTokenRatio).toBe(0);
    expect(rows.slice(1).every(row => JSON.parse(row.metadataJson!).cachedTokenRatio === 0.975)).toBe(true);
    expect(rows.every(row => typeof JSON.parse(row.metadataJson!).timeToFirstTokenMs === 'number')).toBe(true);
  }, 20_000);

  it('waits only for the session prewarm still in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture('openai/gpt-6-sol', false, gate);
    try {
      await vi.waitFor(() => expect(f.bodies).toHaveLength(1));
      const result = f.session.prompt('Answer briefly');
      await vi.waitFor(() => expect(f.events.some(event => event.type === 'agent_start')).toBe(true));
      expect(f.bodies).toHaveLength(1);
      release();
      expect((await result).text).toBe('Finished');
      expect(f.receipts.map(receipt => receipt.purpose)).toEqual(['prewarm', 'turn']);
    } finally { release(); }
  }, 20_000);

  it.each(['abort', 'close'] as const)('cancels an idle session prewarm on %s and retains its reservation', async action => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture('openai/gpt-6-sol', false, gate);
    try {
      await vi.waitFor(() => expect(f.bodies).toHaveLength(1));
      await f.session[action]();
      await f.warmFinished;
      expect(f.receipts).toMatchObject([{ purpose: 'prewarm', status: 'stopped', costUsd: null }]);
      expect(f.ceiling.spentUsd).toBe(f.receipts[0].reservedUsd);
      expect(f.ceiling.spentUsd).toBeGreaterThan(0);
      expect(f.bodies).toHaveLength(1);
    } finally { release(); }
  }, 20_000);

  it('honors the host opt-out and preserves ordinary tool calls', async () => {
    vi.stubEnv('O8_PROMPT_CACHE_WARMING', 'off');
    const { session, bodies, receipts } = await fixture('openai/gpt-6-sol');
    expect(bodies).toHaveLength(0);
    expect((await session.prompt('Read the receipt')).text).toBe('Finished');
    expect((await session.prompt('Answer again')).text).toBe('Finished');
    expect(receipts.map(receipt => receipt.purpose)).toEqual(['turn', 'turn', 'turn']);
    expect(bodies.every(body => !body.prompt_cache_options)).toBe(true);
  }, 20_000);

  it('reaches the same cache lifecycle through the orchestrator sendTurn adapter', async () => {
    const f = await fixture('openai/gpt-6-sol', false);
    await f.warmFinished;
    await f.session.close();
    f.receipts.length = 0; f.bodies.length = 0;
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

  it('preserves initial warming costs and resets the orchestrator ceiling only on reuse', async () => {
    const f = await fixture('openai/gpt-6-sol', false);
    await f.warmFinished;
    await f.session.close();
    f.bodies.length = 0;
    const reset = vi.spyOn(OpenRouterSpendCeiling.prototype, 'reset');
    const backend = createPiOrchestratorBackend({ stateRoot: () => join(f.root, 'lead-budget'),
      openServers: async () => ({ servers: [], close: async () => {} }),
      resolveRoute: async () => ({ carrier: 'openrouter', model: f.model, pricing: f.pricing,
        choice: 'openrouter/' + f.model.id, label: 'Fixture model' }),
      openRouterFetch: f.fixtureFetch, openRouterTurnCeilingUsd: () => 1,
    });
    const events: OrchestratorEvent[] = [];
    try {
      await backend.sendTurn(f.workspace, 'Answer briefly', event => events.push(event), { model: 'openrouter/' + f.model.id });
      expect(reset).not.toHaveBeenCalled();
      expect(events.at(-1)).toMatchObject({ type: 'done', cost: 0.002 });
      await backend.sendTurn(f.workspace, 'Answer again', event => events.push(event), { model: 'openrouter/' + f.model.id });
      expect(reset).toHaveBeenCalledTimes(1);
      expect(events.at(-1)).toMatchObject({ type: 'done', cost: 0.001 });
      expect(f.bodies.filter(body => body.max_tokens === 1)).toHaveLength(1);
      const rows = getDb()!.select().from(usageLogs).all()
        .filter(row => row.repoPath === f.workspace && row.role === 'orchestrator');
      expect(rows.map(row => JSON.parse(row.metadataJson!).purpose)).toEqual(['prewarm', 'turn', 'turn']);
    } finally { reset.mockRestore(); await backend.closeAll?.(); }
  }, 20_000);

});
