import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createModels, fauxAssistantMessage, fauxProvider, type AssistantMessage } from '@earendil-works/pi-ai';
import { SymonBrain, SYMON_FAILED_REPLY } from '@/lib/symon/durable/brain';
import { createSymonManagedProvider, SYMON_MANAGED_MODEL } from '@/lib/symon/durable/managed-provider';
import { piAllowanceExhaustedMessage } from '@/lib/pi/sdk/transport';

const roots: string[] = [];
const brains: SymonBrain[] = [];

afterEach(async () => {
  await Promise.all(brains.splice(0).map((brain) => brain.close().catch(() => {})));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function storagePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'o8-symon-brain-'));
  roots.push(root);
  return join(root, 'symon', 'durable.sqlite');
}

async function open(path: string, faux = fauxProvider()) {
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const brain = await SymonBrain.open({ storagePath: path, models, model: { provider: model.provider, modelId: model.id } });
  brains.push(brain);
  return { brain, faux };
}

const thread = { key: 'imessage:direct:+15555550100', source: 'messages' as const, title: 'Direct messages' };

describe('durable Symon brain (#3453)', () => {
  it('answers an input and lists the thread with its transcript', async () => {
    const { brain, faux } = await open(storagePath());
    faux.setResponses([fauxAssistantMessage('Lunch is at noon.')]);

    const outcome = await brain.send({ ...thread, requestId: 'event-1', text: 'When is lunch?' }, 10_000);

    expect(outcome).toEqual({ state: 'done', text: 'Lunch is at noon.' });
    const listed = await brain.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ key: thread.key, source: 'messages', title: 'Direct messages' });
    expect((await brain.transcript(thread.key))?.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: 'When is lunch?' },
      { role: 'assistant', text: 'Lunch is at noon.' },
    ]);
    expect(await brain.transcript('imessage:direct:unknown')).toBeNull();
  });

  it('answers a repeated delivery from the same submission without a second model call', async () => {
    const { brain, faux } = await open(storagePath());
    faux.setResponses([fauxAssistantMessage('Done.')]);

    const first = await brain.send({ ...thread, requestId: 'event-2', text: 'Ping' }, 10_000);
    const again = await brain.send({ ...thread, requestId: 'event-2', text: 'Ping' }, 10_000);

    expect(first).toEqual({ state: 'done', text: 'Done.' });
    expect(again).toEqual(first);
    expect(faux.state.callCount).toBe(1);
    expect((await brain.transcript(thread.key))?.filter((entry) => entry.role === 'user')).toHaveLength(1);
  });

  it('keeps one conversation per thread and carries context across inputs', async () => {
    const { brain, faux } = await open(storagePath());
    const seen: string[][] = [];
    const record = (context: { messages: readonly unknown[] }) => seen.push(context.messages.map((message) => {
      const { role, content } = message as { role: string; content: unknown };
      return `${role}:${typeof content === 'string' ? content : JSON.stringify(content)}`;
    }));
    faux.setResponses([
      (context) => { record(context); return fauxAssistantMessage('First answer.'); },
      (context) => { record(context); return fauxAssistantMessage('Second answer.'); },
      (context) => { record(context); return fauxAssistantMessage('Other thread.'); },
    ]);

    await brain.send({ ...thread, requestId: 'a', text: 'One' }, 10_000);
    await brain.send({ ...thread, requestId: 'b', text: 'Two' }, 10_000);
    await brain.send({ key: 'phone:session-1', source: 'phone', title: 'Phone', requestId: 'c', text: 'Hello' }, 10_000);

    // Each request opens with Symon's system prompt; the thread's earlier turns ride along, the other thread's never do.
    expect(seen.map((messages) => messages.map((line) => line.split(':')[0]))).toEqual([
      ['system', 'user'],
      ['system', 'user', 'assistant', 'user'],
      ['system', 'user'],
    ]);
    expect(seen[1].slice(1).join('\n')).toContain('One');
    expect(seen[1].slice(1).join('\n')).toContain('First answer.');
    expect(seen[2].join('\n')).not.toContain('First answer.');
    expect((await brain.list()).map((row) => row.key).sort()).toEqual(['imessage:direct:+15555550100', 'phone:session-1']);
  });

  it('resumes an interrupted turn in a new harness on the same store and answers it once', async () => {
    const path = storagePath();
    const firstFaux = fauxProvider();
    let release: () => void = () => {};
    firstFaux.setResponses([async (_context, options) => {
      await new Promise<void>((resolve) => {
        release = resolve;
        options?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return fauxAssistantMessage('', { stopReason: 'aborted', errorMessage: 'Stopped' });
    }]);
    const { brain: first } = await open(path, firstFaux);

    expect(await first.send({ ...thread, requestId: 'event-3', text: 'Still there?' }, 300)).toEqual({ state: 'pending' });
    await first.close();
    brains.splice(brains.indexOf(first), 1);
    release();

    const secondFaux = fauxProvider();
    secondFaux.setResponses([fauxAssistantMessage('Yes, I am here.')]);
    const { brain: second } = await open(path, secondFaux);
    const outcome = await second.send({ ...thread, requestId: 'event-3', text: 'Still there?' }, 10_000);

    expect(outcome).toEqual({ state: 'done', text: 'Yes, I am here.' });
    expect(secondFaux.state.callCount).toBe(1);
    const transcript = await second.transcript(thread.key);
    expect(transcript?.filter((entry) => entry.role === 'user')).toHaveLength(1);
    expect(transcript?.at(-1)).toMatchObject({ role: 'assistant', text: 'Yes, I am here.' });
  });

  it('shows only the allowance message or a fixed reply when a turn fails', async () => {
    const allowance = piAllowanceExhaustedMessage({ period: 'week' });
    const { brain, faux } = await open(storagePath());
    faux.setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: allowance }),
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'upstream 500: {"secret":"raw provider body"}' }),
    ]);

    const capped = await brain.send({ ...thread, requestId: 'event-4', text: 'Hi' }, 10_000);
    const failed = await brain.send({ ...thread, requestId: 'event-5', text: 'Hi again' }, 10_000);

    expect(capped).toEqual({ state: 'failed', message: allowance });
    expect(failed).toEqual({ state: 'failed', message: SYMON_FAILED_REPLY });
  });
});

describe('Symon managed provider', () => {
  it('sends through the host-resolved route and streams the answer', async () => {
    const requests: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }> = [];
    const provider = createSymonManagedProvider({
      resolveRoute: async () => ({ via: 'proxy', url: 'https://relay.test/v1/inference', headers: { authorization: 'Bearer host-only' } }) as never,
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          authorization: new Headers(init?.headers).get('authorization'),
          body: JSON.parse(String(init?.body)),
        });
        return new Response('data: {"choices":[{"delta":{"content":"Managed hello"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const models = createModels();
    models.setProvider(provider);
    const model = models.getModel(SYMON_MANAGED_MODEL.provider, SYMON_MANAGED_MODEL.id)!;

    const message = await models.complete(model, { messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }] });

    expect(message.content).toEqual([{ type: 'text', text: 'Managed hello' }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: 'https://relay.test/v1/inference', authorization: 'Bearer host-only' });
    expect(requests[0].body.model).toBe(SYMON_MANAGED_MODEL.id);
  });

  it('carries the durable brain prompt and thread history in the managed request body', async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const models = createModels();
    models.setProvider(createSymonManagedProvider({
      resolveRoute: async () => ({ via: 'proxy', url: 'https://relay.test/v1/inference', headers: {} }) as never,
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(`data: {"choices":[{"delta":{"content":"Reply ${bodies.length}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } });
      },
    }));
    const brain = await SymonBrain.open({ storagePath: storagePath(), models });
    brains.push(brain);

    expect(await brain.send({ ...thread, requestId: 'm-1', text: 'First question' }, 10_000)).toEqual({ state: 'done', text: 'Reply 1' });
    expect(await brain.send({ ...thread, requestId: 'm-2', text: 'Second question' }, 10_000)).toEqual({ state: 'done', text: 'Reply 2' });

    const [system, ...rest] = bodies[1].messages;
    expect(system.role).toBe('system');
    expect(String(system.content)).toContain('You are Symon');
    expect(String(system.content)).toContain('text-message thread');
    expect(rest.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(JSON.stringify(rest)).toContain('First question');
    expect(JSON.stringify(rest)).toContain('Reply 1');
  });

  it('reports a missing entitlement as o8 text and nothing else', async () => {
    const provider = createSymonManagedProvider({ resolveRoute: async () => null });
    const models = createModels();
    models.setProvider(provider);
    const model = models.getModel(SYMON_MANAGED_MODEL.provider, SYMON_MANAGED_MODEL.id)!;

    const message: AssistantMessage = await models.complete(model, { messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }] });

    expect(message.stopReason).toBe('error');
    expect(message.errorMessage).toBe('Managed inference entitlement is required');
  });
});
