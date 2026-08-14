import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dataDir: string;
const originalEnv = new Map<string, string | undefined>();
const scopedEnvKeys = [
  'CORTEX_IDE_DATA_DIR',
  'O8_MASTER_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_AI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GEMINI_API_KEY',
  'O8_LOCAL_INFERENCE_BASE_URL',
  'O8_LOCAL_CHAT_MODEL',
];

function sseResponse(text: string): Response {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

function operatorRequest(): NextRequest {
  return new NextRequest('http://localhost/api/v2/proxy/llm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'o8-default',
      provider: 'operator',
      messages: [
        { role: 'assistant', content: 'Previous turn' },
        { role: 'user', content: 'Reply through the configured route.' },
      ],
      disableTools: true,
    }),
  });
}

describe('operator POST resolved inference routes', () => {
  beforeEach(() => {
    vi.resetModules();
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-operator-post-'));
    for (const key of scopedEnvKeys) originalEnv.set(key, process.env[key]);
    process.env.CORTEX_IDE_DATA_DIR = dataDir;
    process.env.O8_MASTER_KEY = Buffer.alloc(32, 7).toString('base64url');
    for (const key of scopedEnvKeys.slice(2)) delete process.env[key];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dataDir, { recursive: true, force: true });
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    originalEnv.clear();
  });

  it('uses an encrypted persisted BYOK key after a cold module load', async () => {
    const storedKey = 'sk-or-persisted-route-test';
    const { encryptValue } = await import('@/lib/db/master-key');
    const { ciphertext, iv } = await encryptValue(storedKey);
    writeFileSync(path.join(dataDir, '.env.local'), `OPENROUTER_API_KEY=enc:${iv}:${ciphertext}\n`);
    expect(readFileSync(path.join(dataDir, '.env.local'), 'utf8')).not.toContain(storedKey);

    const upstreamFetch = vi.fn<(
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>>().mockResolvedValue(sseResponse('stored key reached'));
    vi.stubGlobal('fetch', upstreamFetch);
    const { POST } = await import('./route');

    const response = await POST(operatorRequest());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('stored key reached');
    expect(upstreamFetch).toHaveBeenCalledOnce();
    const [url, init] = upstreamFetch.mock.calls[0];
    expect(String(url)).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${storedKey}` });
  }, 30_000);

  it('uses a live local endpoint and its configured model override', async () => {
    process.env.O8_LOCAL_INFERENCE_BASE_URL = 'http://127.0.0.1:11434';
    process.env.O8_LOCAL_CHAT_MODEL = 'local-route-model';
    const upstreamFetch = vi.fn<(
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>>(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'local-route-model' }] });
      if (url.endsWith('/v1/chat/completions')) return sseResponse('local route reached');
      return new Response('unexpected route', { status: 500 });
    });
    vi.stubGlobal('fetch', upstreamFetch);
    const { POST } = await import('./route');

    const response = await POST(operatorRequest());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('local route reached');
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
    const [url, init] = upstreamFetch.mock.calls[1];
    expect(String(url)).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect((init as RequestInit).headers).not.toHaveProperty('Authorization');
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({ model: 'local-route-model' });
  }, 30_000);
});
