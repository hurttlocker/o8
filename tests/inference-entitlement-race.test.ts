import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AssistantMessageEvent, Model } from '@earendil-works/pi-ai/compat';
import { exportSPKI, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { NextRequest } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clerk/nextjs/server', () => ({ auth: async () => ({ userId: null }) }));

const RELAY = 'https://relay.invalid';
const callers = ['chat', 'pi'] as const;
type Caller = typeof callers[number];
let dataDir: string;
let privateKey: CryptoKey;
let publicKeyPem: string;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function signedLicense(plan: 'free' | 'pro' | 'founder') {
  return new SignJWT({ plan })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(plan === 'free' ? 'install_fixture' : 'user_paid_fixture')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

function holdFreeResponse(license: string, inference?: (init?: RequestInit) => Response) {
  const requested = deferred<void>();
  const response = deferred<Response>();
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === `${RELAY}/v1/inference` && inference) return Promise.resolve(inference(init));
    expect(String(input)).toBe(`${RELAY}/issue-free`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      installId: readFileSync(path.join(dataDir, 'install-id'), 'utf8').trim(),
    });
    requested.resolve();
    return response.promise;
  });
  vi.stubGlobal('fetch', fetchMock);
  return { requested: requested.promise, respond: () => response.resolve(Response.json({ license })), fetchMock };
}

async function applyLicense(licenseKey: string) {
  const { POST } = await import('@/app/api/panel/entitlement/route');
  const response = await POST(new Request('http://localhost/api/panel/entitlement', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ licenseKey }),
  }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ source: 'file' });
  return readFileSync(path.join(dataDir, 'entitlement.json'), 'utf8');
}

async function resolveRoute(caller: Caller) {
  const routes = await import('@/lib/cortex/qa/llm/inference-route');
  return caller === 'chat'
    ? routes.resolveOpenRouterRoute({ provisionInstallAllowance: true })
    : routes.resolvePiInferenceRoute();
}

function expectPersistedLicense(persisted: string) {
  expect(readFileSync(path.join(dataDir, 'entitlement.json'), 'utf8')).toBe(persisted);
}

async function submitChat() {
  const { POST } = await import('@/app/api/v2/proxy/llm/route');
  return POST(new NextRequest('http://localhost/api/v2/proxy/llm', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'operator', model: 'o8-default', disableTools: true,
      messages: [
        { role: 'assistant', content: 'Previous turn' },
        { role: 'user', content: 'Reply through the configured route.' },
      ],
    }),
  }));
}

function inferenceResponse() {
  return new Response('data: {"choices":[{"delta":{"content":"Fixture answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('inference callers during free entitlement issuance', () => {
  beforeAll(async () => {
    const pair = await generateKeyPair('EdDSA');
    privateKey = pair.privateKey;
    publicKeyPem = await exportSPKI(pair.publicKey);
  });

  beforeEach(() => {
    vi.resetModules();
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-inference-entitlement-race-'));
    vi.stubEnv('CORTEX_IDE_DATA_DIR', dataDir);
    vi.stubEnv('O8_PLAN', undefined);
    vi.stubEnv('O8_PROXY_URL', RELAY);
    vi.stubEnv('O8_LICENSE_PUBKEY', publicKeyPem);
    vi.stubEnv('OPENROUTER_API_KEY', undefined);
    vi.stubEnv('GOOGLE_AI_API_KEY', undefined);
    vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', undefined);
    vi.stubEnv('GEMINI_API_KEY', undefined);
    vi.stubEnv('O8_LOCAL_INFERENCE_BASE_URL', '');
    vi.stubEnv('O8_LOCAL_CHAT_MODEL', '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe.each(callers)('%s resolver', (caller) => {
    it.each(['pro', 'founder'] as const)('uses the %s license applied during pending free issuance', async (plan) => {
      const paidLicense = await signedLicense(plan);
      const held = holdFreeResponse(await signedLicense('free'));
      const pending = resolveRoute(caller);
      await held.requested;
      const persisted = await applyLicense(paidLicense);
      held.respond();

      expect(await pending).toEqual({
        via: 'proxy', url: `${RELAY}/v1/inference`,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${paidLicense}` },
      });
      expectPersistedLicense(persisted);
      expect(held.fetchMock).toHaveBeenCalledOnce();
    });

    it('keeps View as Free from using a paid token applied during issuance', async () => {
      const held = holdFreeResponse(await signedLicense('free'));
      const pending = resolveRoute(caller);
      await held.requested;
      const persisted = await applyLicense(await signedLicense('pro'));
      writeFileSync(path.join(dataDir, 'dev-plan-override'), JSON.stringify({ plan: 'free' }));
      held.respond();

      expect(await pending).toBeNull();
      expectPersistedLicense(persisted);
      expect(held.fetchMock).toHaveBeenCalledOnce();
    });

    it('continues to use the issued free token when no paid license arrives', async () => {
      const freeLicense = await signedLicense('free');
      const held = holdFreeResponse(freeLicense);
      const pending = resolveRoute(caller);
      await held.requested;
      held.respond();

      expect(await pending).toMatchObject({
        via: 'proxy', headers: { Authorization: `Bearer ${freeLicense}` },
      });
      expect(JSON.parse(readFileSync(path.join(dataDir, 'entitlement.json'), 'utf8'))).toMatchObject({
        plan: 'free', licenseKey: freeLicense,
      });
    });
  });

  it.each(callers)('keeps the %s plan pin from treating a newly applied paid token as a free allowance', async (caller) => {
    const held = holdFreeResponse(await signedLicense('free'));
    const pending = resolveRoute(caller);
    await held.requested;
    const persisted = await applyLicense(await signedLicense('pro'));
    vi.stubEnv('O8_PLAN', 'free');
    held.respond();

    expect(await pending).toBeNull();
    expectPersistedLicense(persisted);
  });

  describe('real chat POST with persisted licenses', () => {
    it.each(['pro', 'founder'] as const)('does not forward a cached %s token under the free pin', async (plan) => {
      const persisted = await applyLicense(await signedLicense(plan));
      vi.stubEnv('O8_PLAN', 'free');
      const upstream = vi.fn(async () => inferenceResponse());
      vi.stubGlobal('fetch', upstream);

      const response = await submitChat();
      expect(response.status).toBe(503);
      expect(upstream).not.toHaveBeenCalled();
      expectPersistedLicense(persisted);
    });

    it('refuses a paid token arriving while free issuance waits and the plan becomes pinned', async () => {
      const held = holdFreeResponse(await signedLicense('free'), () => inferenceResponse());
      const pending = submitChat();
      await held.requested;
      const persisted = await applyLicense(await signedLicense('pro'));
      vi.stubEnv('O8_PLAN', 'free');
      held.respond();

      expect((await pending).status).toBe(503);
      expect(held.fetchMock).toHaveBeenCalledOnce();
      expectPersistedLicense(persisted);
    });

    it.each(['free', 'pro', 'founder'] as const)('streams normally with an unpinned signed %s token', async (plan) => {
      const license = await signedLicense(plan);
      const persisted = await applyLicense(license);
      const upstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(`${RELAY}/v1/inference`);
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${license}`);
        return inferenceResponse();
      });
      vi.stubGlobal('fetch', upstream);

      const response = await submitChat();
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('Fixture answer');
      expect(upstream).toHaveBeenCalledOnce();
      expectPersistedLicense(persisted);
    });

    it('keeps View as Free offline without changing the paid license', async () => {
      const persisted = await applyLicense(await signedLicense('founder'));
      writeFileSync(path.join(dataDir, 'dev-plan-override'), JSON.stringify({ plan: 'free' }));
      const upstream = vi.fn(async () => inferenceResponse());
      vi.stubGlobal('fetch', upstream);

      expect((await submitChat()).status).toBe(503);
      expect(upstream).not.toHaveBeenCalled();
      expectPersistedLicense(persisted);
    });
  });

  it('completes managed inference through the default Pi transport after the paid license arrives', async () => {
    const paidLicense = await signedLicense('pro');
    const held = holdFreeResponse(await signedLicense('free'), (init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${paidLicense}`);
      expect(init?.redirect).toBe('error');
      return new Response('data: {"choices":[{"delta":{"content":"Paid answer"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\ndata: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const model: Model<'openai-completions'> = {
      id: 'fixture', name: 'Fixture', api: 'openai-completions', provider: 'o8-managed',
      baseUrl: 'https://o8-host.invalid/v1', reasoning: false, input: ['text'],
      contextWindow: 16000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const { createManagedPiTransport } = await import('@/lib/pi/sdk/transport');
    const transport = createManagedPiTransport({ model });
    const pending = (async () => {
      const events: AssistantMessageEvent[] = [];
      for await (const event of transport({ messages: [{ role: 'user', content: 'Say hello', timestamp: 0 }] }, new AbortController().signal)) {
        events.push(event);
      }
      return events;
    })();
    await held.requested;
    const persisted = await applyLicense(paidLicense);
    held.respond();

    const events = await pending;
    expect(events).toContainEqual(expect.objectContaining({ type: 'text_delta', delta: 'Paid answer' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'done', reason: 'stop' }));
    expect(events.some(event => event.type === 'error')).toBe(false);
    expectPersistedLicense(persisted);
    expect(held.fetchMock).toHaveBeenCalledTimes(2);
  });
});
