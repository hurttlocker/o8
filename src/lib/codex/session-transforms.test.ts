import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { recoverCodexSessionTransform, transformCodexSession } from './session-transforms';

const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-codex-transform-adapter-'));
const fakeCodex = path.join(fixtureRoot, 'codex-fixture.mjs');
const previousCodexBin = process.env.O8_CODEX_BIN;
const previousCodexHome = process.env.CODEX_HOME;

beforeAll(() => {
  writeFileSync(fakeCodex, `#!/usr/bin/env node
import readline from 'node:readline';
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.145.0\\n');
  process.exit(0);
}
const thread = (id, parent = null) => ({
  id, sessionId: 'session-tree-1', forkedFromId: parent, parentThreadId: null,
  preview: 'fixture task', ephemeral: false, historyMode: 'full', modelProvider: 'fixture',
  createdAt: 1, updatedAt: 2, recencyAt: 2, status: { type: 'idle' }, path: '/tmp/fixture.jsonl',
  cwd: ${JSON.stringify(fixtureRoot)}, cliVersion: 'fixture', source: parent ? 'appServer' : 'exec', canAcceptDirectInput: true,
  threadSource: parent ? 'o8-session-transform:operation-recovery' : null, agentNickname: null, agentRole: null,
  gitInfo: { sha: 'abc123', branch: 'main', originUrl: null }, name: null,
  turns: [{ id: 'turn-complete-1', items: [], itemsView: 'summary', status: 'completed', error: null,
    startedAt: 1, completedAt: 2, durationMs: 1000 }],
});
const getThread = (id) => id === 'fork-thread-1' ? thread(id, 'root-thread-1') : thread(id);
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') process.stdout.write(JSON.stringify({ id: request.id, result: { userAgent: 'fixture' } }) + '\\n');
  else if (request.method === 'thread/read') process.stdout.write(JSON.stringify({ id: request.id, result: { thread: getThread(request.params.threadId) } }) + '\\n');
  else if (request.method === 'thread/list') process.stdout.write(JSON.stringify({ id: request.id, result: { data: [getThread('fork-thread-1')], nextCursor: null, backwardsCursor: null } }) + '\\n');
  else if (request.method === 'thread/fork' && request.params.lastTurnId !== 'turn-complete-1') process.stdout.write(JSON.stringify({ id: request.id, error: { code: -32602, message: 'turn not found' } }) + '\\n');
  else if (request.method === 'thread/fork') process.stdout.write(JSON.stringify({ id: request.id, result: { thread: thread('fork-thread-1', request.params.threadId), model: 'fixture', modelProvider: 'fixture', serviceTier: null, cwd: ${JSON.stringify(fixtureRoot)} } }) + '\\n');
});
`, { mode: 0o755 });
  chmodSync(fakeCodex, 0o755);
  process.env.O8_CODEX_BIN = fakeCodex;
  process.env.CODEX_HOME = fixtureRoot;
});

afterAll(() => {
  if (previousCodexBin === undefined) delete process.env.O8_CODEX_BIN;
  else process.env.O8_CODEX_BIN = previousCodexBin;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
});

describe('Codex provider-native session transforms', () => {
  it('reads a durable thread, resolves a checkpoint, and forks through app-server', async () => {
    const imported = await transformCodexSession({ action: 'import', sessionKey: 'codex:root-thread-1' });
    expect(imported).toMatchObject({
      ok: true,
      originalSession: { sessionKey: 'codex:root-thread-1', ownership: 'provider' },
      providerSessionCreated: false,
    });

    const checkpoint = await transformCodexSession({ action: 'checkpoint', sessionKey: 'codex:root-thread-1' });
    expect(checkpoint).toMatchObject({ ok: true, providerCheckpointRef: 'turn-complete-1' });

    const forked = await transformCodexSession({
      action: 'fork',
      sessionKey: 'codex:root-thread-1',
      providerCheckpointRef: checkpoint.providerCheckpointRef,
    });
    expect(forked).toMatchObject({
      ok: true,
      resultingSession: { sessionKey: 'codex:fork-thread-1' },
      providerCheckpointRef: 'turn-complete-1',
      providerSessionCreated: true,
    });
  }, 15_000);

  it('refuses stale provider checkpoints without calling rollback', async () => {
    const stale = await transformCodexSession({
      action: 'rewind',
      sessionKey: 'codex:root-thread-1',
      providerCheckpointRef: 'missing-turn',
    });
    expect(stale).toMatchObject({
      ok: false,
      reason: 'stale_checkpoint',
      sideEffect: 'none',
      retryable: false,
    });
  }, 15_000);

  it('recovers an app-server fork after interrupted catalog persistence', async () => {
    const recovered = await recoverCodexSessionTransform({
      action: 'fork',
      sessionKey: 'codex:root-thread-1',
      providerCheckpointRef: 'turn-complete-1',
      operationId: 'operation-recovery',
      startedAt: new Date(0).toISOString(),
    });
    expect(recovered).toMatchObject({
      ok: true,
      resultingSession: { sessionKey: 'codex:fork-thread-1' },
      providerSessionCreated: true,
    });
  }, 15_000);
});
