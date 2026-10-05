import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportSPKI, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import type { Model } from '@earendil-works/pi-ai';

// Real worker, default host transport, real route resolver and entitlement files.
// Only the network is faked: the relay, the license server, a live local endpoint
// and a BYO OpenRouter key all answer, so any fallback would be recorded.
const RELAY = 'https://relay.test';
const LOCAL = 'http://127.0.0.1:65530';
const model: Model<'openai-completions'> = { id: 'fixture', name: 'Fixture', api: 'openai-completions',
  provider: 'o8-managed', baseUrl: 'https://o8-host.invalid/v1', reasoning: false, input: ['text'],
  contextWindow: 16000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

let privateKey: CryptoKey;
let publicKeyPem: string;
beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA');
  privateKey = pair.privateKey; publicKeyPem = await exportSPKI(pair.publicKey);
});
function license(plan: 'free' | 'pro', subject: string) {
  return new SignJWT({ plan }).setProtectedHeader({ alg: 'EdDSA' }).setSubject(subject)
    .setIssuedAt().setExpirationTime('1h').sign(privateKey);
}

let root: string;
let dataDir: string;
const sessions: { close(): Promise<void> }[] = [];
beforeEach(async () => {
  vi.resetModules();
  root = await realpath(await mkdtemp(join(tmpdir(), 'o8-pi-free-route-')));
  dataDir = join(root, 'data'); await mkdir(dataDir); await mkdir(join(root, 'workspace'));
  vi.stubEnv('CORTEX_IDE_DATA_DIR', dataDir);
  vi.stubEnv('O8_PLAN', undefined);
  vi.stubEnv('O8_PROXY_URL', RELAY);
  vi.stubEnv('O8_LICENSE_PUBKEY', publicKeyPem);
  vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-synthetic-byok');
  vi.stubEnv('O8_LOCAL_INFERENCE_BASE_URL', LOCAL);
  vi.stubEnv('O8_LOCAL_CHAT_MODEL', 'local-model');
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.close()));
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function network(options: { issuedLicense?: string; inference: () => Response }) {
  const hits = { issue: 0, inference: [] as string[], other: [] as string[] };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${RELAY}/issue-free`) {
      hits.issue++;
      return options.issuedLicense ? Response.json({ license: options.issuedLicense }) : new Response('unavailable', { status: 503 });
    }
    if (url === `${RELAY}/v1/inference`) {
      hits.inference.push(new Headers(init?.headers).get('authorization') ?? '');
      return options.inference();
    }
    hits.other.push(url);
    if (url.startsWith(LOCAL)) return Response.json({ models: [{ name: 'local-model' }] });
    return new Response('data: {"choices":[{"delta":{"content":"Fallback answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  return hits;
}
function answer(text: string) {
  return new Response(`data: {"choices":[{"delta":{"content":"${text}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } });
}
async function session() {
  const { createPiSdkSession } = await import('@/lib/pi/sdk/session');
  const created = await createPiSdkSession({ workspace: join(root, 'workspace'), stateDir: join(root, 'state'), model });
  sessions.push(created); return created;
}

describe('Pi free-plan route through the real worker', () => {
  it('provisions the install allowance and runs on the free route, never local or BYOK', async () => {
    const freeLicense = await license('free', 'install-free');
    const hits = network({ issuedLicense: freeLicense, inference: () => answer('Free answer') });
    const pi = await session();
    const result = await pi.prompt('Say hello');
    expect(result).toMatchObject({ text: 'Free answer', stopReason: 'stop' });
    expect(hits).toEqual({ issue: 1, inference: [`Bearer ${freeLicense}`], other: [] });
    expect(JSON.parse(await readFile(join(dataDir, 'entitlement.json'), 'utf8'))).toMatchObject({ plan: 'free', licenseKey: freeLicense });
    expect(await readFile(pi.sessionFile, 'utf8')).not.toContain(freeLicense);
  }, 15000);

  it('uses the paid plan token on the managed route without issuing a free token', async () => {
    const paidLicense = await license('pro', 'account-paid');
    await writeFile(join(dataDir, 'entitlement.json'), JSON.stringify({ plan: 'pro', status: 'active', licenseKey: paidLicense }));
    const hits = network({ issuedLicense: await license('free', 'install-unused'), inference: () => answer('Paid answer') });
    const result = await (await session()).prompt('Say hello');
    expect(result).toMatchObject({ text: 'Paid answer', stopReason: 'stop' });
    expect(hits).toEqual({ issue: 0, inference: [`Bearer ${paidLicense}`], other: [] });
  }, 15000);

  it('fails closed with no entitlement and sends no model request anywhere', async () => {
    const hits = network({ inference: () => answer('Unexpected answer') });
    const result = await (await session()).prompt('Say hello');
    expect(result.stopReason).toBe('error');
    expect(hits).toEqual({ issue: 1, inference: [], other: [] });
  }, 15000);

  it('fails closed when a paid install views as free instead of spending either allowance', async () => {
    await writeFile(join(dataDir, 'entitlement.json'), JSON.stringify({ plan: 'pro', status: 'active', licenseKey: await license('pro', 'account-viewing') }));
    await writeFile(join(dataDir, 'dev-plan-override'), JSON.stringify({ plan: 'free' }));
    const hits = network({ issuedLicense: await license('free', 'install-unused'), inference: () => answer('Unexpected answer') });
    expect((await (await session()).prompt('Say hello')).stopReason).toBe('error');
    expect(hits).toEqual({ issue: 0, inference: [], other: [] });
  }, 15000);

  it('ends the run with a clear message and no retry when the daily allowance is used up', async () => {
    const freeLicense = await license('free', 'install-exhausted');
    const hits = network({ issuedLicense: freeLicense, inference: () => Response.json(
      { error: 'daily cap reached', plan: 'free', spentMicroUsd: 100_000, capMicroUsd: 100_000 }, { status: 402 }) });
    const pi = await session();
    const result = await pi.prompt('Say hello');
    expect(result).toMatchObject({ stopReason: 'error',
      errorMessage: 'Your daily o8 model allowance is used up. It resets at midnight UTC.' });
    expect(hits.inference).toEqual([`Bearer ${freeLicense}`]);
    expect(hits.other).toEqual([]);
    expect(await readFile(pi.sessionFile, 'utf8')).not.toContain('spentMicroUsd');
  }, 15000);
});
