// Deliberately .ts under the root CommonJS package, like src/ws-server.ts.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { createPiOrchestratorBackend } from '@/lib/lane/orchestrator-backends/pi';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import { SymonBrain } from '@/lib/symon/durable/brain';
import { createManagedPiTransport } from '@/lib/pi/sdk/transport';
import { createOpenRouterPiTransport, openRouterPiModel, OpenRouterSpendCeiling } from '@/lib/pi/sdk/openrouter-transport';

async function main() {
  const pricing = { inputPerMillion: 0, outputPerMillion: 0 };
  const model = openRouterPiModel('fixture', pricing);
  let transportCalls = 0;
  const transport = createOpenRouterPiTransport({ model, pricing, ceiling: new OpenRouterSpendCeiling(1),
    resolveKey: async () => 'synthetic-fixture', fetch: async () => {
      transportCalls++;
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"Transport answer."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    } });
  const workspace = join(process.argv[2], 'workspace');
  await mkdir(workspace);
  const backend = createPiOrchestratorBackend({
    transport, resolveRoute: async () => ({ carrier: 'managed', model, label: 'Fixture' }),
    stateRoot: () => join(process.argv[2], 'lead'),
    openServers: async () => ({ servers: [], close: async () => {} }),
  });
  const events: OrchestratorEvent[] = [];
  try {
    await backend.sendTurn(workspace, 'Hello', event => events.push(event), { threadId: 'fixture', permissionMode: 'plan' });
    assert(!events.some(event => event.type === 'error'), JSON.stringify(events));
    assert(events.some(event => event.type === 'text' && event.text === 'Transport answer.'));
    assert.equal(events.at(-1)?.type, 'done');
  } finally { await backend.closeAll(); }
  assert.equal(typeof createManagedPiTransport, 'function');

  const { createModels, fauxProvider, fauxAssistantMessage } = await import('@earendil-works/pi-ai');
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage('Dev answer.')]);
  const models = createModels();
  models.setProvider(faux.provider);
  const selected = faux.getModel();
  const options = { storagePath: join(process.argv[2], 'durable.sqlite'), models,
    model: { provider: selected.provider, modelId: selected.id }, o8Servers: null };
  const brain = await SymonBrain.open(options);
  let reply;
  try {
    reply = await brain.send({ key: 'app:fixture', source: 'app', title: 'Fixture', requestId: 'one', text: 'Hello' }, 10_000);
    assert.deepEqual(reply, { state: 'done', text: 'Dev answer.' });
    await brain.record({ key: 'app:recorded', source: 'app', title: 'Recorded', requestId: 'recorded',
      entries: [{ role: 'assistant', text: 'Retained exchange.' }] });
  } finally { await brain.close(); }
  const reopened = await SymonBrain.open(options);
  let retained;
  try {
    retained = (await reopened.transcript('app:fixture'))?.some(entry => entry.text === 'Dev answer.');
    assert((await reopened.transcript('app:recorded'))?.some(entry => entry.text === 'Retained exchange.'));
    assert((await readFile(options.storagePath)).length > 0);
  }
  finally { await reopened.close(); }
  console.log(JSON.stringify({ transportCalls, reply: reply.text, retained }));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
