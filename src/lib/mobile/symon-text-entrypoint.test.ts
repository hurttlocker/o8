import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSymonTextSession, loadSymonTextSession, touchSymonTextAttachment } from './symon-text-session-store';
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'o8-symon-entry-')); vi.stubEnv('O8_DATA_DIR', directory); vi.stubEnv('CORTEX_IDE_DATA_DIR', directory); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
/** Compile the production entrypoint without booting ws-server or its funded integrations. */
function entrypoint(owners: Map<string, string>, turns: Map<string, unknown>, send: ReturnType<typeof vi.fn>, run: ReturnType<typeof vi.fn>) {
  const source = readFileSync(new URL('../../ws-server.ts', import.meta.url), 'utf8');
  const start = source.indexOf('function handleSymonTextTurn(');
  const end = source.indexOf('async function handleSymonTextInterrupt(', start);
  const compiled = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function('loadSymonTextSession', 'symonTextClientMatches', 'send', 'symonTextTurns', 'symonTextOwners', 'textTurnKey', 'touchSymonTextAttachment', 'chainOnKey', 'symonTextChains', 'runSymonTextTurn', `${compiled}; return handleSymonTextTurn;`)(
    loadSymonTextSession, (record: { subject: string; deviceId: string }, client: { authKind: string; deviceId: string }) => record.subject === client.authKind && record.deviceId === client.deviceId,
    send, turns, owners, (sessionId: string, turnId: string) => JSON.stringify([sessionId, turnId]), touchSymonTextAttachment,
    (_chains: unknown, _id: string, call: () => void) => call(), new Map(), run,
  );
}
it('wrong principal and non-owner requests cannot mutate another session, its pending turn, receipt window or expiry timer', async () => {
  const record = createSymonTextSession({ subject: 'device', deviceId: 'phone-a', reattachable: true,
    engine: 'claude', model: 'chosen', effort: 'default', workspaceMode: 'o8', repoId: null, repoPath: null, allowedTools: [] });
  touchSymonTextAttachment(record.sessionId, 'working');
  const key = JSON.stringify([record.sessionId, 'working']);
  const owned = { clientId: 'owner', sessionId: record.sessionId, turnId: 'working', terminal: false };
  const turns = new Map([[key, owned]]); const send = vi.fn(); const run = vi.fn();
  const handle = entrypoint(new Map([[record.sessionId, 'owner']]), turns, send, run);
  const file = join(directory, 'symon-text-sessions.json'); const before = readFileSync(file, 'utf8');
  for (const client of [{ id: 'intruder', authKind: 'device', deviceId: 'phone-b' }, { id: 'other-socket', authKind: 'device', deviceId: 'phone-a' }]) {
    handle(client, { sessionId: record.sessionId, turnId: 'working', text: 'mutate this' });
    handle(client, { sessionId: record.sessionId, turnId: 'arbitrary', text: 'mutate this' });
  }
  await vi.advanceTimersByTimeAsync(301000);
  expect(readFileSync(file, 'utf8')).toBe(before); expect(turns.get(key)).toBe(owned); expect(run).not.toHaveBeenCalled();
  handle({ id: 'owner', authKind: 'device', deviceId: 'phone-a' }, { sessionId: record.sessionId, turnId: 'another', text: 'second task' });
  expect(run).not.toHaveBeenCalled(); expect(readFileSync(file, 'utf8')).toBe(before);
});
it.each(['malformed', 'collision'])('keeps %s native approval outcomes unconfirmed', async (kind) => {
  const source = readFileSync(new URL('../../ws-server.ts', import.meta.url), 'utf8');
  const start = source.indexOf("      if (outcome.state === 'needs_confirmation') {");
  const end = source.indexOf("      if (outcome.state === 'done'", start);
  const compiled = ts.transpileModule(`async function run() { while (true) { ${source.slice(start, end)} } }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const done = vi.fn();
  await new Function('outcome', 'turn', 'parseSymonPendingConfirmation', 'symonConfirmationTracker', 'mirroredConfirmations', 'pushSymonTextDone', 'pushSymonConfirmRequired', `${compiled}; return run();`)(
    { state: 'needs_confirmation', confirmation: { tool: 'shell' } }, { sessionId: 's', turnId: 't' },
    () => kind === 'malformed' ? null : { confirmationId: 'same' }, { register: () => false }, new Set(), done, vi.fn(),
  );
  expect(done).toHaveBeenCalledWith(expect.anything(), 'unconfirmed', expect.any(String));
});
it('managed whole-session stop retains unresolved ownership until native terminal evidence', () => {
  const record = createSymonTextSession({ subject: 'device', deviceId: 'phone-a', reattachable: true,
    engine: 'claude', model: 'chosen', effort: 'default', workspaceMode: 'o8', repoId: null, repoPath: null, allowedTools: [] });
  touchSymonTextAttachment(record.sessionId, 'working');
  const source = readFileSync(new URL('../../ws-server.ts', import.meta.url), 'utf8');
  const start = source.indexOf('function handleSymonStop('); const end = source.indexOf('function currentSymonOwner(', start);
  const compiled = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const owners = new Map([[record.sessionId, 'owner']]); const done = vi.fn(); const drop = vi.fn();
  const run = new Function('loadSymonTextSession', 'symonTextClientMatches', 'symonTextOwners', 'symonTextTurns', 'interruptSymonTextNative', 'pushSymonTextDone', 'dropSymonTextSession', 'endSymonMachineSession', `${compiled}; return handleSymonStop;`)(
    loadSymonTextSession, () => true, owners, new Map([['turn', { sessionId: record.sessionId, turnId: 'working', terminal: false }]]), vi.fn(async () => {}), done, drop, vi.fn());
  run({ id: 'owner' }, { sessionId: record.sessionId });
  expect(done).toHaveBeenCalledWith(expect.anything(), 'unconfirmed'); expect(drop).not.toHaveBeenCalled();
  expect(owners.get(record.sessionId)).toBe('owner'); expect(loadSymonTextSession(record.sessionId)?.pendingTurnIds).toEqual(['working']);
});
