import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The managed route, as a signed-in plan resolves it. The polish route sends
// the model list and options; the hosted endpoint is a stub here.
vi.mock('@/lib/cortex/qa/llm/inference-route', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/cortex/qa/llm/inference-route')>(),
  resolveOpenRouterRoute: async () => ({
    url: 'https://relay.test/v1/inference',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer plan.token' },
    via: 'proxy',
  }),
}));

import { POST } from './route';

const fetchMock = vi.fn();
const completion = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
const polish = (transcript: string) => POST(new Request('http://localhost/api/dictation/polish', {
  method: 'POST',
  body: JSON.stringify({ transcript, surface: 'terminal' }),
}));
const sent = (index: number) => JSON.parse(String((fetchMock.mock.calls[index] as [string, RequestInit])[1].body));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('POST /api/dictation/polish on the managed route', () => {
  it('polishes with the managed text model, reasoning off, and returns straight quotes', async () => {
    fetchMock.mockResolvedValueOnce(completion('It’s “done” ‘now’.'));
    const response = await polish('its done now');
    expect(await response.json()).toEqual({ text: 'It\'s "done" \'now\'.', polished: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent(0)).toMatchObject({ model: 'openai/gpt-6-luna', reasoning_effort: 'none' });
  });

  it('falls back to the $0 model without a reasoning field when the managed model fails', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{"error":"unavailable"}', { status: 503 }))
      .mockResolvedValueOnce(completion('Ship it.'));
    const response = await polish('ship it');
    expect(await response.json()).toEqual({ text: 'Ship it.', polished: true });
    expect(sent(1).model).toBe('nvidia/nemotron-3.5-lightning:free');
    expect(sent(1)).not.toHaveProperty('reasoning_effort');
  });
});
