import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { SymonBrain } from '@/lib/symon/durable/brain';
import { GET as listConversations } from '@/app/api/panel/symon/conversations/route';
import { GET as readTranscript } from '@/app/api/panel/symon/conversations/transcript/route';
import { POST as continueConversation } from '@/app/api/panel/symon/conversations/continue/route';

type BrainGlobal = { __o8SymonBrain?: Promise<SymonBrain> };
const TOKEN = 'symon-conversations-test-token';

let dataDir: string;
let previous: { dataDir?: string; token?: string };
let brain: SymonBrain;
let faux: ReturnType<typeof fauxProvider>;

beforeEach(async () => {
  previous = { dataDir: process.env.CORTEX_IDE_DATA_DIR, token: process.env.WS_TOKEN };
  dataDir = mkdtempSync(join(tmpdir(), 'symon-conversations-api-'));
  process.env.CORTEX_IDE_DATA_DIR = dataDir;
  process.env.WS_TOKEN = TOKEN;
  faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  brain = await SymonBrain.open({
    storagePath: join(dataDir, 'symon', 'durable.sqlite'),
    models,
    model: { provider: model.provider, modelId: model.id },
  });
  (globalThis as BrainGlobal).__o8SymonBrain = Promise.resolve(brain);
});

afterEach(async () => {
  delete (globalThis as BrainGlobal).__o8SymonBrain;
  await brain.close();
  rmSync(dataDir, { recursive: true, force: true });
  if (previous.dataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = previous.dataDir;
  if (previous.token === undefined) delete process.env.WS_TOKEN;
  else process.env.WS_TOKEN = previous.token;
});

function get(path: string, authorized = true) {
  return new NextRequest(`http://o8.example.test${path}`, {
    headers: authorized ? { authorization: `Bearer ${TOKEN}` } : {},
  });
}

function post(body: unknown, authorized = true) {
  return new NextRequest('http://o8.example.test/api/panel/symon/conversations/continue', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorized ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify(body),
  });
}

describe('Symon conversations API (#3455)', () => {
  it('lists threads from every source, reads a transcript and continues a thread', async () => {
    faux.setResponses([
      fauxAssistantMessage('Texted answer.'),
      fauxAssistantMessage('Phone answer.'),
      fauxAssistantMessage('Continued in o8.'),
    ]);
    await brain.send({ key: 'imessage:direct:+15555550100', source: 'messages', title: 'Messages', requestId: 'm1', text: 'From my phone' }, 10_000);
    await brain.send({ key: 'phone:session-1', source: 'phone', title: 'Phone', requestId: 'p1', text: 'From the app' }, 10_000);

    const listed = await (await listConversations(get('/api/panel/symon/conversations'))).json();
    expect(listed.ok).toBe(true);
    expect(listed.conversations.map((row: { key: string; source: string }) => [row.key, row.source])).toEqual([
      ['phone:session-1', 'phone'],
      ['imessage:direct:+15555550100', 'messages'],
    ]);

    const continued = await continueConversation(post({ key: 'imessage:direct:+15555550100', requestId: 'ui-1', text: 'Following up here' }));
    expect(await continued.json()).toEqual({ ok: true, state: 'done', text: 'Continued in o8.' });

    const transcript = await (await readTranscript(get(`/api/panel/symon/conversations/transcript?key=${encodeURIComponent('imessage:direct:+15555550100')}`))).json();
    expect(transcript.transcript.map(({ role, text }: { role: string; text: string }) => `${role}: ${text}`)).toEqual([
      'user: From my phone',
      'assistant: Texted answer.',
      'user: Following up here',
      'assistant: Continued in o8.',
    ]);
  });

  it('answers a repeated continue request from the same turn', async () => {
    faux.setResponses([fauxAssistantMessage('Only once.')]);
    const body = { key: 'app:thread-1', requestId: 'ui-2', text: 'Start a thread' };

    const first = await (await continueConversation(post(body))).json();
    const again = await (await continueConversation(post(body))).json();

    expect(first).toEqual({ ok: true, state: 'done', text: 'Only once.' });
    expect(again).toEqual(first);
    expect(faux.state.callCount).toBe(1);
    expect((await brain.summary('app:thread-1'))?.source).toBe('app');
  });

  it('refuses unknown threads, bad input and unauthenticated requests', async () => {
    expect((await continueConversation(post({ key: 'imessage:direct:+19999999999', requestId: 'x', text: 'Hi' }))).status).toBe(404);
    expect((await continueConversation(post({ key: 'app:thread-2', requestId: 'bad id with spaces', text: 'Hi' }))).status).toBe(400);
    expect((await readTranscript(get('/api/panel/symon/conversations/transcript?key=missing'))).status).toBe(404);
    expect((await listConversations(get('/api/panel/symon/conversations', false))).status).toBe(401);
    expect((await readTranscript(get('/api/panel/symon/conversations/transcript?key=x', false))).status).toBe(401);
    expect((await continueConversation(post({ key: 'app:thread-3', requestId: 'y', text: 'Hi' }, false))).status).toBe(401);
    expect(faux.state.callCount).toBe(0);
  });

  it('never returns provider error text in a transcript or reply', async () => {
    faux.setResponses([fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'upstream 500 {"raw":"provider body"}' })]);

    const failed = await (await continueConversation(post({ key: 'app:thread-4', requestId: 'z', text: 'Hi' }))).json();
    const transcript = await (await readTranscript(get('/api/panel/symon/conversations/transcript?key=app%3Athread-4'))).json();

    expect(failed).toEqual({ ok: true, state: 'failed', text: 'Symon could not answer right now. Please try again.' });
    expect(JSON.stringify(transcript)).not.toContain('provider body');
  });
});
