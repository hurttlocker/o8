import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const keys = await vi.hoisted(async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const license = generateKeyPairSync('ed25519'); const pilot = generateKeyPairSync('ed25519');
  return { license, pilot, licensePem: license.publicKey.export({ type: 'spki', format: 'pem' }),
    pilotPem: pilot.publicKey.export({ type: 'spki', format: 'pem' }) };
});
// Replace only public trust roots. Signature, account journal, principal and route logic stay real.
vi.mock('@/lib/entitlement/license', async original => ({
  ...await original<typeof import('@/lib/entitlement/license')>(), LICENSE_PUBLIC_KEY_PEM: keys.licensePem,
}));
vi.mock('@/lib/voice/managed-live/personal-pilot-key', () => ({ PERSONAL_PILOT_PUBLIC_KEY: keys.pilotPem }));
let root: string; let relay: Server; let gateway: string; let calls: string[]; let epoch: string;
let beforeRelayResponse: (() => void) | undefined;
let voice: typeof import('./route'); let state: typeof import('@/lib/auth/account-state');
let pilot: typeof import('@/lib/voice/managed-live/personal-pilot');
const subject = 'user_personal_fixture'; const operator = 'voice-pilot-operator-fixture';
const id = '11111111-1111-4111-8111-111111111111';
const request = (action = 'start', token = operator, binding = 'existing-chat') => new Request('http://localhost/api/voice/live', {
  method: 'POST', headers: { authorization: `Bearer ${token}` },
  body: JSON.stringify({ action, id, binding, after: 0, context: '', sdp: 'v=0\noffer', event: { type: 'session.commentary.append' } }),
});
async function account(sub = subject, options: { expires?: number; signedByPilot?: boolean; fresh?: boolean } = {}) {
  if (options.fresh) epoch = randomUUID();
  const token = await new SignJWT({ plan: 'pro' }).setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(sub).setIssuedAt().setExpirationTime(options.expires ?? Math.floor(Date.now() / 1000) + 3600)
    .sign(options.signedByPilot ? keys.pilot.privateKey : keys.license.privateKey);
  await state.withAccountStateLease(() => {
    state.invalidateAccountState();
    writeFileSync(join(root, 'active-identity'), sub);
    writeFileSync(join(root, 'github-signin-epoch'), epoch);
    writeFileSync(join(root, 'entitlement.json'), JSON.stringify({ plan: 'pro', licenseKey: token }), { mode: 0o600 });
    state.publishReadyAccountState(sub, epoch, token);
  });
  return token;
}
async function grant(overrides: Record<string, unknown> = {}, forged = false) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: pilot.PERSONAL_PILOT_ISSUER, aud: pilot.PERSONAL_PILOT_AUDIENCE,
    sub: subject, iat: now, nbf: now, exp: now + 600, jti: randomUUID(), version: 1,
    purpose: 'personal-live-experiment', installation: pilot.personalPilotInstallation(root, epoch), gateway, ...overrides };
  const token = await new SignJWT(payload).setProtectedHeader({ alg: 'EdDSA' }).sign(forged ? keys.license.privateKey : keys.pilot.privateKey);
  writeFileSync(join(root, 'managed-voice-pilot.jwt'), token, { mode: 0o600 });
}
beforeEach(async () => {
  vi.resetModules(); root = mkdtempSync(join(tmpdir(), 'o8-personal-pilot-')); epoch = randomUUID(); calls = []; beforeRelayResponse = undefined;
  vi.stubEnv('O8_DATA_DIR', root); vi.stubEnv('CORTEX_IDE_DATA_DIR', root); vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('WS_TOKEN', operator); vi.stubEnv('O8_WORKER_TOKEN', 'pilot-worker-fixture'); vi.stubEnv('O8_MANAGED_LIVE_ENABLED', '0');
  relay = createServer(async (req, res) => {
    for await (const _chunk of req) { /* Drain the actual relay request. */ }
    calls.push(`${req.method} ${req.url}`);
    beforeRelayResponse?.();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.method === 'POST' && req.url === '/v1/live/sessions' ? { id, sdp: 'v=0\nanswer' } : { state: 'closed', events: [] }));
  });
  await new Promise<void>(resolve => relay.listen(0, '127.0.0.1', resolve));
  const address = relay.address(); if (!address || typeof address === 'string') throw new Error('Relay missing');
  gateway = `http://127.0.0.1:${address.port}`;
  state = await import('@/lib/auth/account-state'); pilot = await import('@/lib/voice/managed-live/personal-pilot');
  voice = await import('./route'); await account();
});
afterEach(async () => {
  relay.closeAllConnections(); await new Promise<void>((resolve, reject) => relay.close(error => error ? reject(error) : resolve()));
  vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});

it('admits only the enrolled account and operator through real persisted identity and the HTTP relay', async () => {
  await grant();
  expect(await (await voice.GET(request())).json()).toMatchObject({ enabled: true, entitled: true, transport: 'personal-webrtc' });
  writeFileSync(join(root, 'mobile-device-tokens'), createHash('sha256').update('pilot-device-fixture').digest('hex'));
  for (const token of ['', 'unknown-plugin-fixture', 'pilot-worker-fixture', 'pilot-device-fixture']) {
    expect((await voice.POST(request('start', token))).status).toBe(token === 'pilot-device-fixture' ? 403 : 401);
  }
  expect(calls).toEqual([]);
  expect((await voice.POST(request())).status).toBe(200);
  const stored = JSON.parse(readFileSync(join(root, 'managed-voice-relay', `${id}.json`), 'utf8'));
  expect(stored.personal.pilotId).toMatch(/^[a-f0-9-]{36}$/);
  expect(JSON.stringify(stored)).not.toContain(subject);
  await account('user_other_fixture');
  expect((await voice.POST(request())).status).toBe(503);
  expect(await (await voice.GET(request())).json()).toMatchObject({ enabled: false });
  expect((await voice.POST(request('close'))).status).toBe(404);
  expect(calls).toEqual(['POST /v1/live/sessions']);
});

it('ignores unsigned development markers in production and never enables managed admission', async () => {
  writeFileSync(join(root, 'managed-voice-personal.json'), JSON.stringify({ version: 1, gateway, expiresAt: Date.now() + 60000 }), { mode: 0o600 });
  expect(await (await voice.GET(request())).json()).toMatchObject({ enabled: false });
  expect((await voice.POST(request())).status).toBe(503); expect(calls).toEqual([]);
});

it.each(['signature', 'issuer', 'audience', 'purpose', 'future', 'expired', 'overlong', 'origin', 'installation', 'version', 'malformed', 'world-readable', 'symlink'])
('rejects %s grants before the relay is contacted', async kind => {
  const now = Math.floor(Date.now() / 1000);
  const fields: Record<string, Record<string, unknown>> = { issuer: { iss: 'other' }, audience: { aud: 'other' }, purpose: { purpose: 'managed' },
    future: { iat: now + 60, nbf: now + 60 }, expired: { iat: now - 60, nbf: now - 60, exp: now - 1 },
    overlong: { exp: now + 86401 }, origin: { gateway: 'https://example.invalid' }, installation: { installation: 'other' }, version: { version: 2 } };
  await grant(fields[kind] ?? {}, kind === 'signature');
  const file = join(root, 'managed-voice-pilot.jwt');
  if (kind === 'malformed') writeFileSync(file, 'not-a-jwt');
  if (kind === 'world-readable') chmodSync(file, 0o644);
  if (kind === 'symlink') { const content = readFileSync(file); rmSync(file); writeFileSync(join(root, 'other.jwt'), content, { mode: 0o600 }); symlinkSync(join(root, 'other.jwt'), file); }
  expect((await voice.POST(request())).status).toBe(503);
  expect(await (await voice.GET(request())).json()).toMatchObject({ enabled: false }); expect(calls).toEqual([]);
});

it.each(['expired', 'forged', 'subject', 'epoch', 'signed-out'])('rejects %s identity despite a signed pilot grant', async kind => {
  await grant();
  if (kind === 'expired') await account(subject, { expires: Math.floor(Date.now() / 1000) - 1 });
  if (kind === 'forged') { vi.stubEnv('O8_LICENSE_PUBKEY', String(keys.pilotPem)); await account(subject, { signedByPilot: true }); }
  if (kind === 'subject') await account('user_other_fixture');
  if (kind === 'epoch') await account(subject, { fresh: true });
  if (kind === 'signed-out') await state.withAccountStateLease(() => state.holdAccountRefresh());
  expect((await voice.POST(request())).status).toBe(503);
  expect(await (await voice.GET(request())).json()).toMatchObject({ enabled: false }); expect(calls).toEqual([]);
});

it('keeps original relay controls after expiry and credential rotation, but blocks new work and wrong bindings', async () => {
  await grant(); expect((await voice.POST(request())).status).toBe(200);
  await account();
  const now = Math.floor(Date.now() / 1000); await grant({ iat: now - 60, nbf: now - 60, exp: now - 1 });
  expect((await voice.POST(request())).status).toBe(503);
  expect((await voice.POST(request('event'))).status).toBe(503);
  expect((await voice.POST(request('close', operator, 'other-chat'))).status).toBe(404);
  vi.resetModules(); const reloaded = await import('./route');
  expect((await reloaded.POST(request('poll'))).status).toBe(200);
  expect((await reloaded.POST(request('close'))).status).toBe(200);
  expect(calls).toEqual(['POST /v1/live/sessions', `GET /v1/live/sessions/${id}?after=0`, `DELETE /v1/live/sessions/${id}`]);
});

it('refuses a changed account at the relay response while retaining the original owner recovery record', async () => {
  await grant();
  beforeRelayResponse = () => writeFileSync(join(root, 'active-identity'), 'user_changed_fixture');
  expect((await voice.POST(request())).status).toBe(503);
  expect(calls).toHaveLength(1);
  const stored = readFileSync(join(root, 'managed-voice-relay', `${id}.json`), 'utf8');
  expect(JSON.parse(stored).personal).toBeDefined();
  beforeRelayResponse = undefined; writeFileSync(join(root, 'active-identity'), subject);
  expect((await voice.POST(request('close'))).status).toBe(200);
  expect(readFileSync(join(root, 'managed-voice-relay', `${id}.json`), 'utf8')).toBe(stored);
});
