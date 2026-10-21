import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// Only the paid provider transports are replaced. Principal, key lookup,
// persisted account admission, session ownership and route dispatch stay real.
const provider = vi.hoisted(() => ({ sockets: [] as Array<EventEmitter & { readyState: number; sent: string[]; send: (data: string) => void; close: () => void }>, failSend: false, failAttach: false, syncFailure: 0, syncs: 0 }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, fsyncSync: (fd: number) => {
    if (++provider.syncs === provider.syncFailure) throw new Error('Fixture receipt sync failed');
    fs.fsyncSync(fd);
  } };
});
vi.mock('ws', () => ({ default: class extends EventEmitter {
  static OPEN = 1; static CLOSED = 3;
  readyState = 0; sent: string[] = [];
  constructor(readonly url: string, readonly options: unknown) {
    super(); provider.sockets.push(this);
    queueMicrotask(() => { if (provider.failAttach) this.emit('error', new Error('fixture')); else { this.readyState = 1; this.emit('open'); } });
  }
  send(data: string) { if (provider.failSend) throw new Error('fixture'); this.sent.push(data); }
  terminate() { this.close(); }
  close() { this.readyState = 3; this.emit('close'); }
} }));
let root: string; let voice: typeof import('./route');
let fetchMock: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
const operator = 'byok-operator-fixture'; const key = 'sk-byok-secret-fixture'; const binding = 'repo:existing-chat:cli';
const start = () => ({ action: 'start', source: 'byok', requestId: randomUUID(), binding, context: 'Recent backend receipt: still working.', sdp: 'v=0\noffer' });
const request = (body: Record<string, unknown>, token = operator) => new Request('http://localhost/api/voice/live', {
  method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body),
});
const post = (body: Record<string, unknown>, token = operator) => voice.POST(request(body, token));
const poll = (id: string, after = 0) => post({ action: 'poll', id, binding, after });
const emit = (event: Record<string, unknown>, index = 0) => provider.sockets[index].emit('message', Buffer.from(JSON.stringify(event)));
const receipt = (id: string) => JSON.parse(readFileSync(join(root, 'byok-voice-relay', `${id}.json`), 'utf8'));
async function create() { const response = await post(start()); expect(response.status).toBe(200); return await response.json() as { id: string; sdp: string }; }
beforeEach(async () => {
  vi.resetModules(); root = mkdtempSync(join(tmpdir(), 'o8-byok-voice-')); provider.sockets = []; provider.failSend = false; provider.failAttach = false; provider.syncFailure = 0; provider.syncs = 0;
  vi.stubEnv('O8_DATA_DIR', root); vi.stubEnv('CORTEX_IDE_DATA_DIR', root); vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('WS_TOKEN', operator); vi.stubEnv('O8_WORKER_TOKEN', 'byok-worker-fixture'); vi.stubEnv('O8_MANAGED_LIVE_ENABLED', '0'); vi.stubEnv('OPENAI_API_KEY', key);
  fetchMock = vi.fn<typeof globalThis.fetch>(async () => Response.json({ session: { id: `live_fixture_${provider.sockets.length}` }, transport: { type: 'webrtc', sdp: 'v=0\nanswer' } }, { status: 201 }));
  vi.stubGlobal('fetch', fetchMock); voice = await import('./route');
});
afterEach(async () => {
  for (const socket of provider.sockets) socket.close();
  rmSync(root, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});
it('starts for a signed-out local operator with an OpenAI key, without enabling managed access or exposing secrets', async () => {
  const state = await import('@/lib/auth/account-state'); await state.withAccountStateLease(() => state.holdAccountRefresh());
  expect(await (await voice.GET(request({}))).json()).toMatchObject({ enabled: false, byokAvailable: true });
  const created = await create(); expect(created.sdp).toBe('v=0\nanswer'); expect(created.id).not.toBe('live_fixture');
  expect(fetchMock).toHaveBeenCalledOnce(); expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/live/sessions');
  const sent = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
  expect(sent.session).toMatchObject({ model: 'gpt-live-1', delegation: { type: 'client' }, client: { data_channel: { allowed_client_events: [], allowed_server_events: [] } } });
  expect(sent.session.instructions).toContain('first person'); expect(sent.session.instructions).toContain('backend receipt');
  expect(JSON.stringify(created)).not.toContain(key); expect(JSON.stringify(receipt(created.id))).not.toContain(key);
  expect((await post({ action: 'start', binding, context: '', sdp: 'v=0\noffer' })).status).toBe(503);
  expect(fetchMock).toHaveBeenCalledOnce();
});
it('refuses missing keys and anonymous, worker and device credentials before provider calls', async () => {
  writeFileSync(join(root, 'mobile-device-tokens'), createHash('sha256').update('byok-device-fixture').digest('hex'));
  for (const token of ['', 'unknown-fixture', 'byok-worker-fixture', 'byok-device-fixture']) expect((await post(start(), token)).status).toBe(token === 'byok-device-fixture' ? 403 : 401);
  vi.stubEnv('OPENAI_API_KEY', ''); expect((await post(start())).status).toBe(403); expect(fetchMock).not.toHaveBeenCalled();
});
it('deduplicates start requests and retains unknown creation across module restart', async () => {
  const body = start(); const created = await post(body); expect(created.status).toBe(200);
  expect((await post(body)).status).toBe(409); expect((await post(start())).status).toBe(409); expect(fetchMock).toHaveBeenCalledOnce();
  vi.resetModules(); voice = await import('./route');
  expect((await post(start())).status).toBe(409); expect(fetchMock).toHaveBeenCalledOnce();
});
it('pins controls to operator, account, key and chat and never accepts a provider id from the client', async () => {
  const { id } = await create();
  expect((await post({ action: 'close', source: 'byok', id: 'live_fixture', binding })).status).toBe(404);
  expect((await post({ action: 'close', id, binding: 'different-chat' })).status).toBe(404);
  vi.stubEnv('OPENAI_API_KEY', 'sk-other-fixture'); expect((await poll(id)).status).toBe(404);
  vi.stubEnv('OPENAI_API_KEY', key); writeFileSync(join(root, 'active-identity'), 'different-account'); expect((await poll(id)).status).toBe(404);
  expect(provider.sockets[0].sent).toEqual([]); expect(fetchMock).toHaveBeenCalledOnce();
});
it('replays ordered provider events once, validates delegation receipts and deduplicates outgoing events', async () => {
  const { id } = await create();
  const input = { type: 'session.input_transcript.delta', event_id: 'input-1', delta: 'Check this', start_ms: 0, end_ms: 20 };
  emit(input); emit(input);
  emit({ type: 'session.delegation.created', event_id: 'delegation-1', offset_ms: 20, delegation: { id: 'd1', target: 'client' } });
  const events = (await (await poll(id)).json()).events;
  expect(events.map((e: { cursor: number }) => e.cursor)).toEqual([1, 2]);
  expect((await (await poll(id, 2)).json()).events).toEqual([]);
  const event = { type: 'session.commentary.append', event_id: 'reply-1', delegation_id: 'd1', content: 'I am checking.' };
  expect((await post({ action: 'event', id, binding, event })).status).toBe(200);
  expect((await post({ action: 'event', id, binding, event })).status).toBe(200);
  expect((await post({ action: 'event', id, binding, event: { ...event, content: 'Changed' } })).status).toBe(409);
  expect(provider.sockets[0].sent).toHaveLength(1);
  expect((await post({ action: 'event', id, binding, event: { ...event, event_id: 'reply-2', delegation_id: 'invented' } })).status).toBe(400);
});
it('retains unknown failed close and blocks new spend until valid terminal provider usage arrives', async () => {
  const { id } = await create(); provider.failSend = true;
  expect((await post({ action: 'close', id, binding })).status).toBe(200);
  expect(receipt(id).state).toBe('unknown'); expect((await post(start())).status).toBe(409);
  expect(fetchMock).toHaveBeenCalledOnce();
});
it('treats close acknowledgement as pending and only session.closed usage as terminal', async () => {
  const { id } = await create();
  await post({ action: 'close', id, binding }); expect(receipt(id).state).toBe('closing'); expect((await post(start())).status).toBe(409);
  emit({ type: 'session.closed', event_id: 'closed-1', reason: 'close_requested', usage: { seconds: 3 } });
  expect(receipt(id)).toMatchObject({ state: 'closed', finalSeconds: 3 });
  expect((await (await poll(id)).json()).events.at(-1).event).toMatchObject({ type: 'session.closed', usage: { seconds: 3 } });
  await create(); expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('admits a free signed-in profile and resolves the stored key without requiring a paid license', async () => {
  vi.stubEnv('OPENAI_API_KEY', '');
  writeFileSync(join(root, '.env.local'), `OPENAI_API_KEY=${key}\n`, { mode: 0o600 });
  writeFileSync(join(root, 'active-identity'), 'free-account-fixture');
  writeFileSync(join(root, 'github-signin-epoch'), 'free-signin-fixture');
  expect(await (await voice.GET(request({}))).json()).toMatchObject({ enabled: false, entitled: false, byokAvailable: true });
  await create(); expect(fetchMock).toHaveBeenCalledOnce();
});
it('refuses an operator credential changed after startup', async () => {
  const { id } = await create();
  vi.stubEnv('WS_TOKEN', 'changed-operator-fixture');
  expect((await poll(id)).status).toBe(401);
  expect((await post({ action: 'close', id, binding }, 'changed-operator-fixture')).status).toBe(404);
  expect(provider.sockets[0].sent).toEqual([]);
});
it.each(['account', 'key'])('closes acknowledged creation when the %s changes in flight', async kind => {
  fetchMock.mockImplementation(async () => {
    if (kind === 'account') writeFileSync(join(root, 'active-identity'), 'changed-account-fixture');
    else vi.stubEnv('OPENAI_API_KEY', 'changed-key-fixture');
    return Response.json({ session: { id: 'live_changed' }, transport: { sdp: 'v=0\nanswer' } });
  });
  const response = await post(start()); expect(response.status).toBe(409);
  const data = await response.json(); expect(data.id).toMatch(/^[a-f0-9-]{36}$/);
  expect(receipt(data.id).state).toBe('closing');
  expect(provider.sockets[0].sent.map(s => JSON.parse(s).type)).toEqual(['session.close']);
});
it('retains an unacknowledged create across process reload and never silently retries it', async () => {
  fetchMock.mockRejectedValue(new Error(`provider request failed with ${key}`));
  const body = start(); const response = await post(body); expect(response.status).toBe(502);
  const data = await response.json(); expect(JSON.stringify(data)).not.toContain(key);
  expect(receipt(data.id)).toMatchObject({ state: 'unknown', providerId: null });
  vi.resetModules(); voice = await import('./route');
  expect((await post(body)).status).toBe(409); expect((await post(start())).status).toBe(409);
  expect((await post({ action: 'recover', source: 'byok', requestId: body.requestId, binding })).status).toBe(200);
  expect(fetchMock).toHaveBeenCalledOnce(); expect(provider.sockets).toHaveLength(0);
});
it('recovers known sessions after restart only to request close using their persisted provider identity', async () => {
  const { id } = await create(); emit({ type: 'session.closed', event_id: 'closed-old', usage: { seconds: 2 } });
  const recoveredId = randomUUID();
  const prior = { ...receipt(id), id: recoveredId, requestId: randomUUID(), pid: 2147483647, state: 'unknown', finalSeconds: null, events: [], cursor: 0, seen: {}, sent: {}, delegations: [] };
  writeFileSync(join(root, 'byok-voice-relay', `${recoveredId}.json`), JSON.stringify(prior), { mode: 0o600 });
  vi.resetModules(); voice = await import('./route');
  expect((await post(start())).status).toBe(409);
  expect((await post({ action: 'recover', source: 'byok', requestId: prior.requestId, binding, providerId: 'untrusted-provider' })).status).toBe(200);
  expect(provider.sockets).toHaveLength(2);
  expect((provider.sockets[1] as unknown as { url: string }).url).toBe('wss://api.openai.com/v1/live/sessions/live_fixture_0/attach');
  expect(provider.sockets[1].sent.map(s => JSON.parse(s).type)).toEqual(['session.close']);
  expect(receipt(recoveredId).pid).toBe(process.pid);
  emit({ type: 'session.closed', event_id: 'closed-recovered', usage: { seconds: 3 } }, 1);
  expect(receipt(recoveredId)).toMatchObject({ state: 'closed', finalSeconds: 3 });
  await create(); expect(fetchMock).toHaveBeenCalledTimes(2);
});
it('keeps attachment failures unknown and refuses a new create', async () => {
  provider.failAttach = true;
  const response = await post(start()); expect(response.status).toBe(502);
  const { id } = await response.json(); expect(receipt(id)).toMatchObject({ state: 'unknown', providerId: 'live_fixture_0' });
  expect((await post(start())).status).toBe(409); expect(fetchMock).toHaveBeenCalledOnce();
});
it.each(['missing', 'decreased'])('refuses %s terminal usage and retains an unresolved session', async kind => {
  const { id } = await create(); emit({ type: 'session.usage.updated', event_id: 'usage-1', usage: { seconds: 5 } });
  emit({ type: 'session.closed', event_id: 'closed-bad', ...(kind === 'decreased' ? { usage: { seconds: 4 } } : {}) });
  expect(receipt(id).state).toBe('unknown'); expect(receipt(id).finalSeconds).toBeNull();
  expect((await post(start())).status).toBe(409);
});
it('refuses conflicting provider event ids, never replays a delegation id and strips unused secret fields', async () => {
  const { id } = await create();
  emit({ type: 'session.delegation.created', event_id: 'd-event-1', offset_ms: 1, delegation: { id: 'd1', target: 'client' }, credential: key });
  emit({ type: 'session.delegation.created', event_id: 'd-event-2', offset_ms: 1, delegation: { id: 'd1', target: 'client' } });
  expect((await (await poll(id)).json()).events).toHaveLength(1); expect(JSON.stringify(receipt(id))).not.toContain(key);
  emit({ type: 'session.delegation.created', event_id: 'd-event-1', offset_ms: 2, delegation: { id: 'd2', target: 'client' } });
  expect(receipt(id).state).toBe('unknown');
});
it('bounds event history, refuses stale or future cursors and closes before losing delegation continuity', async () => {
  const { id } = await create();
  const { runningByokSession } = await import('@/lib/voice/managed-live/byok-transport');
  const live = runningByokSession(id)!.record;
  live.events = Array.from({ length: 511 }, (_, i) => ({ cursor: i + 1, event: { type: 'session.commentary.appended', event_id: `past-${i}` } }));
  live.cursor = 511;
  writeFileSync(join(root, 'byok-voice-relay', `${id}.json`), JSON.stringify(live), { mode: 0o600 });
  for (let i = 0; i < 3; i++) emit({ type: 'session.input_transcript.delta', event_id: `input-${i}`, delta: 'a', start_ms: i, end_ms: i + 1 });
  expect(receipt(id).events).toHaveLength(512);
  expect((await poll(id, 0)).status).toBe(409); expect(receipt(id).state).toBe('closing');
  expect((await poll(id, 999)).status).toBe(409);
});
it('requests fixed duration closure locally without accepting a caller override or claiming a provider cap', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const response = await post({ ...start(), maxDurationMs: 3600000 }); expect(response.status).toBe(200);
    const { id } = await response.json(); await vi.advanceTimersByTimeAsync(300000);
    expect(receipt(id).state).toBe('closing');
    await vi.advanceTimersByTimeAsync(15000); expect(receipt(id).state).toBe('unknown');
    expect((await post(start())).status).toBe(409);
  } finally { vi.useRealTimers(); }
});
it('rejects unsafe persisted receipts before any provider operation', async () => {
  const { id } = await create(); const file = join(root, 'byok-voice-relay', `${id}.json`);
  chmodSync(file, 0o644); expect((await poll(id)).status).toBe(503); chmodSync(file, 0o600);
  const other = join(root, 'receipt-copy'); writeFileSync(other, readFileSync(file), { mode: 0o600 }); rmSync(file); symlinkSync(other, file);
  expect((await poll(id)).status).toBe(503); expect((await post(start())).status).toBe(503); expect(fetchMock).toHaveBeenCalledOnce();
});

it.each([1, 2])('does not spend when reservation durability sync %i fails', async syncFailure => {
  provider.syncFailure = syncFailure;
  const response = await post(start()); expect(response.status).toBe(503);
  expect(fetchMock).not.toHaveBeenCalled(); expect(provider.sockets).toHaveLength(0);
});
it('retains unknown event submission without replaying it after a send failure', async () => {
  const { id } = await create(); provider.failSend = true;
  const event = { type: 'session.thinking.append', event_id: 'sent-unknown', delegation_id: null, content: 'Current work is pending.' };
  expect((await post({ action: 'event', id, binding, event })).status).toBe(502);
  expect(Object.values(receipt(id).sent)).toMatchObject([{ state: 'pending' }]);
  provider.failSend = false;
  expect((await post({ action: 'event', id, binding, event })).status).toBe(409);
  expect(provider.sockets[0].sent).toEqual([]);
});
it('refuses a duplicate provider identity without attaching or closing another owned session', async () => {
  const { id } = await create(); emit({ type: 'session.closed', event_id: 'closed-duplicate', usage: { seconds: 2 } });
  fetchMock.mockImplementation(async () => Response.json({ session: { id: 'live_fixture_0' }, transport: { sdp: 'v=0\nanswer' } }));
  const response = await post(start()); expect(response.status).toBe(502);
  const data = await response.json(); expect(receipt(data.id)).toMatchObject({ state: 'unknown', providerId: null });
  expect(receipt(id).state).toBe('closed'); expect(provider.sockets).toHaveLength(1); expect(provider.sockets[0].sent).toEqual([]);
});
it('never silently chooses a credential source and never routes pinned controls to a changed source', async () => {
  expect((await post({ ...start(), source: 'other' })).status).toBe(400); expect(fetchMock).not.toHaveBeenCalled();
  const { id } = await create();
  expect((await post({ action: 'close', source: 'managed', id, binding })).status).toBe(200);
  expect(provider.sockets[0].sent.map(s => JSON.parse(s).type)).toEqual(['session.close']); expect(fetchMock).toHaveBeenCalledOnce();
});

it('retains terminal usage when the ordinary provider event replay budget is full', async () => {
  const { id } = await create();
  const { runningByokSession } = await import('@/lib/voice/managed-live/byok-transport');
  const live = runningByokSession(id)!.record;
  live.seen = Object.fromEntries(Array.from({ length: 4096 }, (_, i) => [createHash('sha256').update(`seen-${i}`).digest('hex'), createHash('sha256').update(`event-${i}`).digest('hex')]));
  writeFileSync(join(root, 'byok-voice-relay', `${id}.json`), JSON.stringify(live), { mode: 0o600 });
  emit({ type: 'session.usage.updated', event_id: 'usage-full', usage: { seconds: 2 } });
  expect(receipt(id).state).toBe('closing');
  emit({ type: 'session.closed', event_id: 'terminal-full', usage: { seconds: 3 } });
  expect(receipt(id)).toMatchObject({ state: 'closed', finalSeconds: 3 });
  expect(Object.keys(receipt(id).seen)).toHaveLength(4096);
  await create(); expect(fetchMock).toHaveBeenCalledTimes(2);
});
it.each(['key', 'account', 'operator'])('requests closure of the already-owned socket after %s authority changes', async kind => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    const { id } = await create();
    if (kind === 'key') vi.stubEnv('OPENAI_API_KEY', 'changed-key-fixture');
    if (kind === 'account') writeFileSync(join(root, 'active-identity'), 'changed-account-fixture');
    if (kind === 'operator') vi.stubEnv('WS_TOKEN', 'changed-operator-fixture');
    await vi.advanceTimersByTimeAsync(1000);
    expect(receipt(id).state).toBe('closing');
    expect(provider.sockets[0].sent.map(s => JSON.parse(s).type)).toEqual(['session.close']);
    expect(fetchMock).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});
