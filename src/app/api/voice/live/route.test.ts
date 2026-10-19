import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const config = vi.hoisted(() => ({ gateway: 'https://gateway.fixture', generation: 'account-one', accountId: 'subject-one', epoch: 'sign-in-one', root: '', ready: true, signedOut: false, token: 'signed-plan-fixture', syncFailure: 0, syncs: 0 }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, fsyncSync: (fd: number) => { if (++config.syncs === config.syncFailure) throw new Error('fixture fsync failure'); fs.fsyncSync(fd); } };
});
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => config.root }));
vi.mock('@/lib/mobile/device-registry', () => ({ resolveDeviceByToken: () => null }));
vi.mock('@/lib/mobile/symon-text-session-store', () => ({ loadSymonTextSession: () => null }));
vi.mock('@/lib/auth/account-state', () => ({
  readAccountState: () => ({ generation: config.generation, accountId: config.accountId, epoch: config.epoch, signedOut: config.signedOut, status: config.ready ? 'ready' : 'blocked', licenseDigest: createHash('sha256').update('signed-plan-fixture').digest('hex') }),
  accountStateMatches: (state: { accountId: string; epoch: string }) => config.ready && !config.signedOut && state.accountId === config.accountId && state.epoch === config.epoch,
  withAccountStateAdmission: (action: () => Promise<unknown>) => action(),
}));
vi.mock('@/lib/auth/principal', () => ({ resolveRequestPrincipal: (request: Request) => request.headers.get('x-role') ?? 'operator' }));
vi.mock('@/lib/cortex/qa/llm/inference-route', () => ({ planToken: () => config.token, proxyBaseUrl: () => config.gateway }));
import { GET, POST } from './route';
const ID = '11111111-1111-4111-8111-111111111111';
const start = { action: 'start', binding: 'repo:thread:claude', context: 'history', sdp: 'v=0\noffer' };
const poll = { action: 'poll', binding: start.binding, id: ID, after: 0 };
const request = (body: unknown, token = 'operator-fixture', role = 'operator') => new Request('http://localhost/api/voice/live', {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-role': role }, body: JSON.stringify(body),
});
beforeEach(() => { config.root = mkdtempSync(join(tmpdir(), 'voice-relay-')); config.generation = 'account-one'; config.accountId = 'subject-one'; config.epoch = 'sign-in-one'; config.gateway = 'https://gateway.fixture'; config.ready = true; config.signedOut = false; config.token = 'signed-plan-fixture'; config.syncFailure = 0; config.syncs = 0; });
afterEach(() => { rmSync(config.root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('managed voice application relay', () => {
  it('rejects null and array bodies without throwing', async () => {
    for (const value of [null, [], 2, 'text']) expect((await POST(request(value))).status).toBe(400);
  });
  it('blocks worker/anonymous callers before any funded operation', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); vi.stubEnv('O8_MANAGED_LIVE_ENABLED', '1');
    for (const role of ['worker', 'anonymous', 'spectator']) expect((await POST(request({ action: 'start' }, 'x', role))).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('is disabled unless opted in', async () => {
    vi.stubEnv('O8_MANAGED_LIVE_ENABLED', '0');
    expect((await GET(request({}))).status).toBe(200);
    expect((await POST(request({ action: 'start' }))).status).toBe(503);
  });
  it('preserves the gateway lifetime refusal without retrying or registering a session', async () => {
    vi.stubEnv('O8_MANAGED_LIVE_ENABLED', '1');
    vi.stubEnv('O8_LIVE_EXPIRY_ACCEPTED', '1');
    const fetch = vi.fn(async () => Response.json({ error: 'voice_lifetime_unverified', id: 'refused-session' }, { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    const response = await POST(request({ action: 'start', binding: 'held-chat', context: '', sdp: 'v=0\noffer' }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'voice_lifetime_unverified' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await POST(request({ action: 'poll', id: 'refused-session', binding: 'held-chat', after: 0 }))).status).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps plan token server-side and controls bound to exact principal and conversation', async () => {
    vi.stubEnv('O8_MANAGED_LIVE_ENABLED', '1');
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ id: ID, sdp: 'v=0\nanswer' })); vi.stubGlobal('fetch', fetch);
    const started = await POST(request({ action: 'start', binding: 'repo:thread:claude', context: 'history', sdp: 'v=0\noffer' }));
    expect(started.status).toBe(200); expect(await started.text()).not.toContain('signed-plan-fixture');
    expect(fetch.mock.calls[0]![0]).toBe('https://gateway.fixture/v1/live/sessions');
    expect((await POST(request({ action: 'close', id: ID, binding: 'repo:thread:claude' }, 'other'))).status).toBe(404);
    expect((await POST(request({ action: 'close', id: ID, binding: 'different-thread' }))).status).toBe(404);
    vi.stubEnv('O8_MANAGED_LIVE_ENABLED', '0');
    expect((await POST(request({ action: 'close', id: ID, binding: 'repo:thread:claude' }))).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('recovers ownership after a cold module reload, normalizes bearer whitespace and pins the original gateway', async () => {
    vi.stubEnv('O8_MANAGED_LIVE_ENABLED', '1');
    const fetch = vi.fn(async () => Response.json({ id: ID, sdp: 'v=0\nanswer' })); vi.stubGlobal('fetch', fetch);
    expect((await POST(request(start))).status).toBe(200);
    config.gateway = 'https://different.fixture';
    vi.resetModules();
    const reloaded = await import('./route');
    expect((await reloaded.POST(request(poll, '  operator-fixture  '))).status).toBe(200);
    expect(fetch.mock.calls[1]).toMatchObject(['https://gateway.fixture/v1/live/sessions/' + ID + '?after=0', { redirect: 'error' }]);
    const stored = readFileSync(join(config.root, 'managed-voice-relay', `${ID}.json`), 'utf8');
    for (const secret of ['signed-plan-fixture', 'operator-fixture', start.binding, start.context, start.sdp]) expect(stored).not.toContain(secret);
    config.generation = 'replacement-account';
    config.accountId = 'replacement-subject';
    expect((await reloaded.POST(request(poll))).status).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('keeps persisted controls across housekeeping generations but rejects fresh sign-in and legacy ownership', async () => {
    vi.stubEnv('O8_MANAGED_LIVE_ENABLED', '1');
    const fetch = vi.fn(async () => Response.json({ id: ID, sdp: 'v=0\nanswer' })); vi.stubGlobal('fetch', fetch);
    expect((await POST(request(start))).status).toBe(200);
    const file = join(config.root, 'managed-voice-relay', `${ID}.json`);
    const record = JSON.parse(readFileSync(file, 'utf8'));
    expect(record.version).toBe(2);
    config.generation = 'housekeeping-refresh';
    vi.resetModules(); const reloaded = await import('./route');
    expect((await reloaded.POST(request(poll))).status).toBe(200);
    expect((await reloaded.POST(request({ ...poll, action: 'close' }))).status).toBe(200);
    config.epoch = 'fresh-sign-in';
    expect((await reloaded.POST(request(poll))).status).toBe(404);
    config.epoch = 'sign-in-one';
    writeFileSync(file, JSON.stringify({ ...record, version: 1 }));
    expect((await reloaded.POST(request(poll))).status).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('pins the gateway before create resolves and refuses duplicate ids without overwriting or closing', async () => {
    vi.stubEnv('O8_MANAGED_LIVE_ENABLED', '1');
    const fetch = vi.fn(async () => { config.gateway = 'https://different.fixture'; return Response.json({ id: ID, sdp: 'v=0\nanswer' }); });
    vi.stubGlobal('fetch', fetch);
    expect((await POST(request(start))).status).toBe(200);
    const file = join(config.root, 'managed-voice-relay', `${ID}.json`);
    const original = readFileSync(file, 'utf8');
    expect(JSON.parse(original).gateway).toBe('https://gateway.fixture');
    expect((await POST(request({ ...start, binding: 'another-chat' }))).status).toBe(502);
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('fails closed on corrupt or symlink ownership instead of recreating it or forwarding controls', async () => {
    vi.stubEnv('O8_MANAGED_LIVE_ENABLED', '1');
    const fetch = vi.fn(async () => Response.json({ id: ID, sdp: 'v=0\nanswer' })); vi.stubGlobal('fetch', fetch);
    expect((await POST(request(start))).status).toBe(200);
    const file = join(config.root, 'managed-voice-relay', `${ID}.json`);
    const original = readFileSync(file);
    writeFileSync(file, '{broken');
    expect((await POST(request(poll))).status).toBe(502);
    rmSync(file); const other = join(config.root, 'other.json'); writeFileSync(other, original, { mode: 0o600 }); symlinkSync(other, file);
    expect((await POST(request(poll))).status).toBe(502);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('refuses unsafe configured gateway URLs before sending credentials', async () => {
    vi.stubEnv('O8_MANAGED_LIVE_ENABLED', '1');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    for (const value of ['http://public.fixture', 'https://user:password@gateway.fixture', 'https://gateway.fixture/?redirect=other']) {
      config.gateway = value;
      expect((await POST(request(start))).status).toBe(502);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('runs a local operator preview without any gateway call and keeps controls in the originating chat', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('O8_MANAGED_LIVE_ENABLED', '1');
    writeFileSync(join(config.root, 'managed-voice-preview.json'), JSON.stringify({ version: 1, expiresAt: Date.now() + 60_000 }), { mode: 0o600 });
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(await (await GET(request({}))).json()).toMatchObject({ enabled: true, transport: 'local-preview' });
    const created = await (await POST(request(start))).json();
    expect(created.transport).toBe('local-preview');
    expect((await POST(request({ ...poll, id: created.id }, 'another-operator'))).status).toBe(404);
    expect((await POST(request({ ...poll, id: created.id, binding: 'another-chat' }))).status).toBe(404);
    expect((await POST(request(start, 'device', 'device'))).status).toBe(403);
    expect((await POST(request({ ...poll, id: created.id, action: 'close' }))).status).toBe(200);
    expect(await (await POST(request({ ...poll, id: created.id }))).json()).toMatchObject({ events: [{ event: { type: 'session.closed' } }] });
    writeFileSync(join(config.root, 'managed-voice-preview.json'), '{bad');
    expect((await POST(request(start))).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('cannot enable local preview or bypass the lifetime hold in production', async () => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('O8_MANAGED_LIVE_ENABLED', '1'); vi.stubEnv('O8_LIVE_EXPIRY_ACCEPTED', '1');
    writeFileSync(join(config.root, 'managed-voice-preview.json'), JSON.stringify({ version: 1, expiresAt: Date.now() + 60_000 }), { mode: 0o600 });
    const fetch = vi.fn(async () => Response.json({ error: 'voice_lifetime_unverified' }, { status: 503 })); vi.stubGlobal('fetch', fetch);
    expect((await POST(request(start))).status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects blocked, signed-out and mismatched-token accounts before contacting the gateway', async () => {
    vi.stubEnv('O8_MANAGED_LIVE_ENABLED', '1'); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    config.ready = false; expect((await POST(request(start))).status).toBe(503);
    config.ready = true; config.signedOut = true; expect((await POST(request(start))).status).toBe(503);
    config.signedOut = false; config.token = 'another-account-token'; expect((await POST(request(start))).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('applies current account and license checks to existing session controls', async () => {
    vi.stubEnv('O8_MANAGED_LIVE_ENABLED', '1');
    const fetch = vi.fn(async () => Response.json({ id: ID, sdp: 'answer' })); vi.stubGlobal('fetch', fetch);
    expect((await POST(request(start))).status).toBe(200);
    for (const action of ['poll', 'close']) {
      config.ready = false; expect((await POST(request({ ...poll, action }))).status).toBe(503);
      config.ready = true; config.signedOut = true; expect((await POST(request({ ...poll, action }))).status).toBe(503);
      config.signedOut = false; config.token = 'wrong-license'; expect((await POST(request({ ...poll, action }))).status).toBe(503);
      config.token = 'signed-plan-fixture';
    }
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(['generation', 'sign-out', 'account', 'epoch'])('does not return success after out-of-band account %s changes during creation', async change => {
    vi.stubEnv('O8_MANAGED_LIVE_ENABLED', '1');
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (change === 'generation') config.generation = 'account-two';
      else if (change === 'account') config.accountId = 'other-subject';
      else if (change === 'epoch') config.epoch = 'other-sign-in';
      else config.signedOut = true;
      return Response.json({ id: ID, sdp: 'v=0\nanswer' });
    }));
    expect((await POST(request(start))).status).toBe(503);
    expect(readFileSync(join(config.root, 'managed-voice-relay', `${ID}.json`), 'utf8')).not.toContain('account-two');
  });
  it.each([1, 2])('preserves unknown creation when sync %i fails; only definitively published ids receive closure', async syncFailure => {
    vi.stubEnv('O8_MANAGED_LIVE_ENABLED', '1'); config.syncFailure = syncFailure;
    const fetch = vi.fn(async () => Response.json({ id: ID, sdp: 'v=0\nanswer' })); vi.stubGlobal('fetch', fetch);
    expect((await POST(request(start))).status).toBe(502);
    expect(fetch).toHaveBeenCalledTimes(syncFailure === 2 ? 2 : 1);
    config.syncFailure = 0;
    expect((await POST(request(poll))).status).toBe(syncFailure === 2 ? 200 : 404);
  });
  it.skipIf(process.platform === 'win32')('rejects a FIFO promptly without blocking the route', async () => {
    vi.stubEnv('O8_MANAGED_LIVE_ENABLED', '1');
    const fetch = vi.fn(async () => Response.json({ id: ID, sdp: 'v=0\nanswer' })); vi.stubGlobal('fetch', fetch);
    expect((await POST(request(start))).status).toBe(200);
    const file = join(config.root, 'managed-voice-relay', `${ID}.json`); rmSync(file); execFileSync('mkfifo', [file]);
    expect((await POST(request(poll))).status).toBe(502); expect(fetch).toHaveBeenCalledTimes(1);
    vi.stubEnv('NODE_ENV', 'development'); execFileSync('mkfifo', [join(config.root, 'managed-voice-preview.json')]);
    expect((await POST(request(start))).status).toBe(503); expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('personal development relay isolation', () => {
  const configure = (gateway = 'http://127.0.0.1:45678', expiresAt = Date.now() + 60_000) => {
    writeFileSync(join(config.root, 'managed-voice-personal.json'), JSON.stringify({ version: 1, gateway, expiresAt }), { mode: 0o600 });
  };
  it('uses an explicit loopback test while leaving ordinary inference routing and production admission unchanged', async () => {
    vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('O8_MANAGED_LIVE_ENABLED', '0'); configure();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ id: ID, sdp: 'v=0\nanswer' })); vi.stubGlobal('fetch', fetch);
    expect(await (await GET(request({}))).json()).toMatchObject({ transport: 'personal-webrtc', enabled: true });
    expect((await POST(request(start))).status).toBe(200);
    expect(fetch.mock.calls[0][0]).toBe('http://127.0.0.1:45678/v1/live/sessions');
    expect(config.gateway).toBe('https://gateway.fixture');
    expect((await POST(request(start, 'device', 'device'))).status).toBe(403);
    vi.stubEnv('NODE_ENV', 'production');
    expect(await (await GET(request({}))).json()).toMatchObject({ enabled: false });
    expect((await POST(request(start))).status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('refuses invalid, expired, symlinked and non-loopback configuration without falling through to a provider', async () => {
    vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('O8_MANAGED_LIVE_ENABLED', '1');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    for (const gateway of ['https://example.com', 'http://localhost:45678', 'http://127.0.0.1:45678/path', 'http://user@127.0.0.1:45678']) {
      configure(gateway); expect((await POST(request(start))).status).toBe(503);
    }
    configure('http://127.0.0.1:45678', Date.now() - 1); expect((await POST(request(start))).status).toBe(503);
    rmSync(join(config.root, 'managed-voice-personal.json'));
    writeFileSync(join(config.root, 'other.json'), JSON.stringify({ version: 1, gateway: 'http://127.0.0.1:45678', expiresAt: Date.now() + 60_000 }), { mode: 0o600 });
    symlinkSync(join(config.root, 'other.json'), join(config.root, 'managed-voice-personal.json'));
    expect((await POST(request(start))).status).toBe(503); expect(fetch).not.toHaveBeenCalled();
  });
  it('still closes the acknowledged session through its pinned relay after the test expires, even with preview configured', async () => {
    vi.stubEnv('NODE_ENV', 'development'); vi.stubEnv('O8_MANAGED_LIVE_ENABLED', '0'); configure();
    writeFileSync(join(config.root, 'managed-voice-preview.json'), JSON.stringify({ version: 1, expiresAt: Date.now() + 60_000 }), { mode: 0o600 });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ id: ID, state: 'closed' })); vi.stubGlobal('fetch', fetch);
    expect((await POST(request(start))).status).toBe(200);
    configure('http://127.0.0.1:45678', Date.now() - 1);
    expect((await POST(request(start))).status).toBe(503);
    expect((await POST(request({ ...poll, action: 'close' }))).status).toBe(200);
    expect(fetch.mock.calls[1][0]).toBe(`http://127.0.0.1:45678/v1/live/sessions/${ID}`);
    expect((await POST(request({ ...poll, action: 'close' }, 'other-operator'))).status).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
