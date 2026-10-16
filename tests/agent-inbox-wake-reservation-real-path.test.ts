import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentMessageDeliverySeams } from '@/lib/agents/delivery';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-inbox-wake-reservation-'));
const token = 'inbox-wake-reservation-fixture-token';
writeFileSync(join(dataDir, 'ws-token'), `${token}\n`, 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { AGENT_NATIVE_WAKE_TTL_MS, ensureAgentBusSchema, releaseAgentInboxWake } = await import('@/lib/agents/store');
const { closeDb, getSqlite } = await import('@/lib/db');
const { createAgentMessagePostHandler } = await import('@/lib/agents/message-route-handler');
const presenceRoute = await import('@/app/api/agents/presence/route');
const inboxRoute = await import('@/app/api/agents/inbox/route');

function request(path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3001/api/agents/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { host: 'localhost:3001', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(suffix: string, sendCodex: AgentMessageDeliverySeams['sendCodex']) {
  const agentId = `wake-${suffix}`;
  const name = `Receiver-${suffix}`;
  const repo = join(dataDir, suffix);
  const sessionKey = `codex:${agentId}`;
  const joinTarget = () => presenceRoute.POST(request('presence', {
    agentId, name, repo, worktreePath: repo, runtime: 'codex', sessionKey,
  }));
  expect((await joinTarget()).status).toBe(201);
  const sendClaude = vi.fn<AgentMessageDeliverySeams['sendClaude']>().mockRejectedValue(new Error('Unexpected runtime'));
  const post = createAgentMessagePostHandler({ sendCodex, sendClaude }, {
    discoverSessions: async () => [], resolveRepoPath: async () => null, now: () => new Date(),
  });
  return {
    agentId, name, repo, sessionKey, joinTarget,
    post: (text: string) => post(request('message', { from: 'operator', to: name, repo, text })),
    read: async (limit = 100) => {
      const response = await inboxRoute.GET(request(`inbox?agentId=${agentId}&limit=${limit}`));
      expect(response.status).toBe(200);
      return response.json() as Promise<{ messages: Array<{ id: string; text: string; delivery: string }>; hasMore: boolean }>;
    },
    state: () => getSqlite().prepare('SELECT * FROM agent_inbox_state WHERE repo_path = ? AND agent_name = ?')
      .get(repo, name) as Record<string, unknown>,
  };
}

// Exercise real authorization, presence/message/inbox routes and SQLite with
// fake native submission and empty discovery, not native dequeue/cancellation.
describe('inbox wake reservation ownership through actual routes', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T12:00:00.000Z'));
  });
  afterEach(() => { vi.useRealTimers(); });
  afterAll(() => { closeDb(); });

  it.each(['reject', 'resolve'] as const)('preserves the newer wake when the acknowledged old submission settles: %s', async (settlement) => {
    const started = deferred();
    const queue = deferred();
    const sendCodex = vi.fn<AgentMessageDeliverySeams['sendCodex']>()
      .mockImplementationOnce(async () => { started.resolve(); await queue.promise; })
      .mockResolvedValue(undefined);
    const target = await fixture(`ack-race-${settlement}`, sendCodex);
    const pending = target.post('A: acknowledged while submission is pending');
    try {
      await Promise.race([started.promise, pending.then(() => { throw new Error('Submission ended before barrier'); })]);
      expect((await target.read()).messages.map((message) => message.text)).toEqual([
        'A: acknowledged while submission is pending',
      ]);
      expect((await target.post('B: new after acknowledgement')).status).toBe(201);
      expect(sendCodex).toHaveBeenCalledTimes(2);
      const reserved = target.state();
      if (settlement === 'reject') queue.reject(new Error('Old queue submission rejected'));
      else queue.resolve();
      const settled = await pending;
      expect(settled.status).toBe(201);
      await expect(settled.json()).resolves.toMatchObject({ message: {
        delivery: 'native', deliveryNote: 'Read from the durable inbox by the target session.',
      } });
      expect(target.state()).toEqual(reserved);
      expect((await target.post('C: coalesced with B')).status).toBe(201);
      expect(sendCodex).toHaveBeenCalledTimes(2);
      expect(sendCodex).toHaveBeenLastCalledWith(expect.objectContaining({
        agentId: target.agentId, repo: target.repo, sessionKey: target.sessionKey,
      }), expect.stringContaining('[o8 agent inbox]'));
      // No in-flight service call holds the connection when it is reopened.
      closeDb();
      const first = await target.read(1);
      expect(first.messages.map((message) => message.text)).toEqual(['B: new after acknowledgement']);
      expect(first.hasMore).toBe(true);
      expect((await target.post('D: coalesced after partial acknowledgement')).status).toBe(201);
      expect(sendCodex).toHaveBeenCalledTimes(2);
      const rest = await target.read();
      expect(rest.messages.map((message) => message.text)).toEqual([
        'C: coalesced with B', 'D: coalesced after partial acknowledgement',
      ]);
      expect(rest.hasMore).toBe(false);
      expect((await target.read()).messages).toEqual([]);
      expect((await target.post('E: genuinely new after full acknowledgement')).status).toBe(201);
      expect(sendCodex).toHaveBeenCalledTimes(3);
      expect((await target.read()).messages.map((message) => message.text)).toEqual([
        'E: genuinely new after full acknowledgement',
      ]);
      expect((await target.read()).messages).toEqual([]);
    } finally {
      queue.resolve();
      await pending;
    }
  });


  it('protects a replacement at the exact TTL boundary from an older pending failure', async () => {
    const started = deferred();
    const queue = deferred();
    const sendCodex = vi.fn<AgentMessageDeliverySeams['sendCodex']>()
      .mockImplementationOnce(async () => { started.resolve(); await queue.promise; })
      .mockResolvedValue(undefined);
    const target = await fixture('ttl-race', sendCodex);
    const pending = target.post('A: pending before expiry');
    try {
      await Promise.race([started.promise, pending.then(() => { throw new Error('Missing queue barrier'); })]);
      const original = target.state();
      vi.setSystemTime(Date.now() + AGENT_NATIVE_WAKE_TTL_MS - 1);
      expect((await target.joinTarget()).status).toBe(201);
      expect((await target.post('B: just before expiry')).status).toBe(201);
      expect(sendCodex).toHaveBeenCalledTimes(1);
      expect(target.state().native_wake_id).toBe(original.native_wake_id);
      vi.setSystemTime(Date.now() + 1);
      expect((await target.post('C: at expiry')).status).toBe(201);
      expect(sendCodex).toHaveBeenCalledTimes(2);
      const replacement = target.state();
      expect(replacement.native_wake_id).not.toBe(original.native_wake_id);
      queue.reject(new Error('Expired submission failed'));
      expect((await pending).status).toBe(201);
      expect(target.state()).toEqual(replacement);
      expect((await target.post('D: coalesced with replacement')).status).toBe(201);
      expect(sendCodex).toHaveBeenCalledTimes(2);
      closeDb();
      expect((await target.read()).messages.map((message) => message.text)).toEqual([
        'A: pending before expiry', 'B: just before expiry', 'C: at expiry', 'D: coalesced with replacement',
      ]);
      expect((await target.read()).messages).toEqual([]);
    } finally {
      queue.resolve();
      await pending;
    }
  });

  it('releases its own failed reservation after coalescing and partial ACK so a new message retries', async () => {
    const started = deferred();
    const queue = deferred();
    const sendCodex = vi.fn<AgentMessageDeliverySeams['sendCodex']>()
      .mockImplementationOnce(async () => { started.resolve(); await queue.promise; })
      .mockResolvedValue(undefined);
    const target = await fixture('retry', sendCodex);
    const pending = target.post('A: pending');
    try {
      await Promise.race([started.promise, pending.then(() => { throw new Error('Missing queue barrier'); })]);
      const originalId = target.state().native_wake_id;
      expect((await target.post('B: coalesced')).status).toBe(201);
      expect((await target.read(1)).messages.map((message) => message.text)).toEqual(['A: pending']);
      expect(target.state().native_wake_id).toBe(originalId);
      queue.reject(new Error('Current submission failed'));
      expect((await pending).status).toBe(201);
      expect(target.state()).toMatchObject({ native_wake_id: null, native_wake_session_key: null });
      expect((await target.post('C: retry')).status).toBe(201);
      expect(sendCodex).toHaveBeenCalledTimes(2);
      expect(target.state().native_wake_id).not.toBe(originalId);
      expect((await target.read()).messages.map((message) => message.text)).toEqual(['B: coalesced', 'C: retry']);
      expect((await target.read()).messages).toEqual([]);
    } finally {
      queue.resolve();
      await pending;
    }
  });

  it.each(['ack', 'ttl'] as const)('coalesces legacy null-ID reservations until %s without clearing unowned work', async (expiry) => {
    const sendCodex = vi.fn<AgentMessageDeliverySeams['sendCodex']>().mockResolvedValue(undefined);
    const target = await fixture(`legacy-${expiry}`, sendCodex);
    expect((await target.post('A: legacy pending')).status).toBe(201);
    getSqlite().prepare('UPDATE agent_inbox_state SET native_wake_id = NULL WHERE repo_path = ?')
      .run(target.repo);
    const legacy = target.state();
    const agent = {
      agentId: target.agentId, name: target.name, repo: target.repo, sessionKey: target.sessionKey,
      worktreePath: target.repo, runtime: 'codex', laneId: null, packetId: null, lastSeen: new Date().toISOString(),
    };
    releaseAgentInboxWake(agent, 'unowned-reservation');
    releaseAgentInboxWake(agent, '');
    expect(target.state()).toEqual(legacy);
    expect((await target.post('B: coalesced with legacy')).status).toBe(201);
    expect(sendCodex).toHaveBeenCalledTimes(1);
    expect(target.state().native_wake_id).toBeNull();
    if (expiry === 'ack') {
      expect((await target.read()).messages).toHaveLength(2);
    } else {
      vi.setSystemTime(Date.now() + AGENT_NATIVE_WAKE_TTL_MS);
      expect((await target.joinTarget()).status).toBe(201);
    }
    expect((await target.post('C: fresh reservation')).status).toBe(201);
    expect(sendCodex).toHaveBeenCalledTimes(2);
    expect(target.state().native_wake_id).toEqual(expect.any(String));
    const current = target.state();
    const id = current.native_wake_id as string;
    for (const other of [{ ...agent, repo: `${agent.repo}-other` }, { ...agent, name: 'Other' },
      { ...agent, sessionKey: 'codex:other' }]) releaseAgentInboxWake(other, id);
    expect(target.state()).toEqual(current);
    closeDb();
    expect((await target.read()).messages).toHaveLength(expiry === 'ack' ? 1 : 3);
    expect((await target.read()).messages).toEqual([]);
    expect(target.state().native_wake_id).toBeNull();
  });

  it('adds a nullable reservation ID without rewriting legacy pending state or durable messages', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE agent_inbox_state (
          repo_path TEXT NOT NULL, agent_name TEXT NOT NULL COLLATE NOCASE,
          acknowledged_sequence INTEGER NOT NULL DEFAULT 0,
          native_wake_session_key TEXT, native_wake_through_sequence INTEGER NOT NULL DEFAULT 0,
          native_wake_at TEXT, PRIMARY KEY(repo_path, agent_name)
        );
        INSERT INTO agent_inbox_state VALUES
          ('/legacy-fixture', 'Legacy', 6, 'codex:legacy', 7, '2026-10-14T12:00:00.000Z');
        CREATE TABLE agent_messages (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          from_agent TEXT NOT NULL, to_agent TEXT NOT NULL, repo_path TEXT NOT NULL,
          text TEXT NOT NULL, refs_json TEXT NOT NULL DEFAULT '{}',
          delivery_status TEXT NOT NULL, delivery_note TEXT, created_at TEXT NOT NULL
        );
        INSERT INTO agent_messages
          (sequence, id, from_agent, to_agent, repo_path, text, delivery_status, created_at)
        VALUES (7, 'legacy-seven', 'operator', 'Legacy', '/legacy-fixture', 'Unread legacy message',
          'poll', '2026-10-14T12:00:00.000Z');
      `);
      const state = sqlite.prepare('SELECT * FROM agent_inbox_state').get() as Record<string, unknown>;
      const message = sqlite.prepare('SELECT * FROM agent_messages').get() as Record<string, unknown>;
      ensureAgentBusSchema(sqlite);
      ensureAgentBusSchema(sqlite);
      expect(sqlite.prepare('SELECT * FROM agent_inbox_state').get()).toEqual({ ...state, native_wake_id: null });
      expect(sqlite.prepare('SELECT * FROM agent_messages').get()).toMatchObject(message);
    } finally {
      sqlite.close();
    }
  });


  it('serializes legacy column discovery with ALTER across independent SQLite connections', () => {
    const path = join(dataDir, 'migration-race.db');
    const first = new Database(path);
    const second = new Database(path, { timeout: 0 });
    try {
      ensureAgentBusSchema(first);
      first.exec('ALTER TABLE agent_inbox_state DROP COLUMN native_wake_id');
      const pragma = first.pragma.bind(first);
      let contenderBlocked = false;
      const discovery = vi.spyOn(first, 'pragma').mockImplementation((source, options) => {
        const result = pragma(source, options);
        if (source === 'table_info(agent_inbox_state)') {
          // Schedule another connection immediately after the missing-column read.
          try { second.exec('ALTER TABLE agent_inbox_state ADD COLUMN native_wake_id TEXT'); }
          catch (error) {
            expect(error).toMatchObject({ code: 'SQLITE_BUSY' });
            contenderBlocked = true;
          }
        }
        return result;
      });
      expect(() => ensureAgentBusSchema(first)).not.toThrow();
      discovery.mockRestore();
      expect(contenderBlocked).toBe(true);
      expect(() => ensureAgentBusSchema(second)).not.toThrow();
      const columns = second.pragma('table_info(agent_inbox_state)') as Array<{ name: string }>;
      expect(columns.filter((column) => column.name === 'native_wake_id')).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      first.close();
      second.close();
    }
  });


  it('finishes overlapping legacy startup migrations in two owned child processes', async () => {
    const path = join(dataDir, 'process-migration.db');
    const release = join(dataDir, 'release-migration');
    const seed = new Database(path);
    ensureAgentBusSchema(seed);
    seed.exec('ALTER TABLE agent_inbox_state DROP COLUMN native_wake_id');
    seed.close();
    const launch = (role: 'holder' | 'contender') => {
      const script = `
        import { existsSync } from 'node:fs';
        import Database from 'better-sqlite3';
        const store = await import('./src/lib/agents/store.ts');
        const ensure = store.ensureAgentBusSchema ?? store.default.ensureAgentBusSchema;
        const sqlite = new Database(${JSON.stringify(path)}, { timeout: 10000 });
        const role = ${JSON.stringify(role)};
        if (role === 'holder') {
          const pragma = sqlite.pragma.bind(sqlite);
          sqlite.pragma = (source, options) => {
            const result = pragma(source, options);
            if (source === 'table_info(agent_inbox_state)') {
              process.stdout.write('BARRIER\\n');
              const deadline = Date.now() + 10000;
              while (!existsSync(${JSON.stringify(release)})) {
                if (Date.now() > deadline) throw new Error('Migration barrier timed out');
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
              }
            }
            return result;
          };
        } else {
          const exec = sqlite.exec.bind(sqlite);
          let entered = false;
          sqlite.exec = (sql) => {
            if (!entered) { entered = true; process.stdout.write('BARRIER\\n'); }
            return exec(sql);
          };
        }
        try { ensure(sqlite); } finally { sqlite.close(); }
      `;
      const child = spawn(process.execPath, [
        '--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '--input-type=module', '-e', script,
      ], { cwd: process.cwd(), env: { ...process.env, O8_DATA_DIR: join(dataDir, role),
        CORTEX_IDE_DATA_DIR: join(dataDir, role) }, timeout: 20000 });
      let output = '';
      let errors = '';
      const barrier = deferred();
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('BARRIER\n')) barrier.resolve();
      });
      child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
      const done = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      const ready = Promise.race([barrier.promise, done.then((code) => {
        throw new Error(`Migration child ended before barrier: ${code} ${errors}`);
      })]);
      return { child, done, ready, errors: () => errors };
    };
    const children: ReturnType<typeof launch>[] = [];
    try {
      const holder = launch('holder'); children.push(holder);
      await holder.ready;
      const contender = launch('contender'); children.push(contender);
      await contender.ready;
      writeFileSync(release, 'release');
      for (const child of children) expect(await child.done, child.errors()).toBe(0);
      const check = new Database(path);
      try {
        const columns = check.pragma('table_info(agent_inbox_state)') as Array<{ name: string }>;
        expect(columns.filter((column) => column.name === 'native_wake_id')).toHaveLength(1);
      } finally { check.close(); }
    } finally {
      writeFileSync(release, 'release');
      for (const { child } of children) if (child.exitCode === null) child.kill('SIGTERM');
      await Promise.allSettled(children.map((child) => child.done));
    }
  });
});
