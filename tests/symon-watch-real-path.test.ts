/**
 * Symon standing watches, driven through the seams a real operator reaches:
 * the watch registration route, the durable automation scheduler, a live
 * ws-server holding a real `symon` channel session, and the loopback
 * task-completion bridge the background brain already uses.
 *
 * The ws-server runs with its own scheduler disabled so the tick is
 * deterministic; every fire in here is materialized by this process against the
 * same SQLite file the server reads.
 */
import { execFile, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-symon-watch-data-'));
const repoPath = mkdtempSync(join(tmpdir(), 'o8-symon-watch-repo-'));
const token = 'symon-watch-real-path-token';

mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, 'ws-token'), `${token}\n`, { mode: 0o600 });
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

let wsProcess: ChildProcess;
let wsPort = 0;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('missing test port'));
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // still booting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('ws-server did not become healthy');
}

wsPort = await freePort();
const apiPort = await freePort();
process.env.O8_API_PORT = String(apiPort);
process.env.O8_WS_PORT = String(wsPort);

const watchesRoute = await import('@/app/api/symon/watches/route');
const watchRoute = await import('@/app/api/symon/watches/[id]/route');
const { getSqlite, closeDb } = await import('@/lib/db');
const { createLane } = await import('@/lib/lane/registry');
const { recordLaneEvent } = await import('@/lib/lane/events');
const { listAutomationFires } = await import('@/lib/automations/fire-store');
const { runAutomationSchedulerTick } = await import('@/lib/automations/scheduler');
const { listSymonWatches } = await import('@/lib/automations/symon-watch');
const { readSymonWatchLedger, closeSymonWatchLedger } = await import('@/lib/automations/symon-watch-ledger');
const { persistSymonScopeGrant, SYMON_SCOPE_VERSION } = await import('@/lib/mobile/symon-agent-registry');

type SymonFrame = Record<string, unknown>;

interface LiveSession {
  socket: WebSocket;
  frames: SymonFrame[];
  taskCompletes: SymonFrame[];
  close: () => Promise<void>;
}

/** Register one real phone-side Symon session over the `symon` channel. */
async function openSymonSession(sessionId: string): Promise<LiveSession> {
  persistSymonScopeGrant({
    sessionId,
    subject: 'operator',
    deviceId: null,
    workspaceMode: 'o8',
    toolPack: 'o8',
    repoId: null,
    repoPath: null,
    allowedTools: ['symon_watch', 'symon_watch_list', 'symon_watch_run'],
    issuedAt: Date.now(),
    scopeVersion: SYMON_SCOPE_VERSION,
  });
  const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(token)}`);
  await once(socket, 'open');
  const frames: SymonFrame[] = [];
  const taskCompletes: SymonFrame[] = [];
  socket.on('message', (raw) => {
    const frame = JSON.parse(String(raw)) as SymonFrame;
    if (frame.channel !== 'symon') return;
    frames.push(frame);
    if (frame.type === 'symon-task-complete') taskCompletes.push(frame);
  });
  const registered = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('symon session never acknowledged')), 10_000);
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as SymonFrame;
      if (frame.channel === 'symon' && frame.type === 'symon-agent-status' && frame.sessionId === sessionId) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  socket.send(JSON.stringify({
    channel: 'symon',
    type: 'symon-agent-status',
    sessionId,
    status: 'live',
  }));
  // The server answers registration on the same channel; if it stays silent the
  // session is not owned and no push would ever reach this client.
  await Promise.race([registered, new Promise((resolve) => setTimeout(resolve, 1_500))]);
  return {
    socket,
    frames,
    taskCompletes,
    close: async () => {
      socket.send(JSON.stringify({ channel: 'symon', type: 'symon-agent-status', sessionId, status: 'idle' }));
      await new Promise((resolve) => setTimeout(resolve, 250));
      socket.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
  };
}

async function waitForTaskComplete(session: LiveSession, watchId: string): Promise<SymonFrame> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const frame = session.taskCompletes.find((candidate) => candidate.taskId === watchId);
    if (frame) return frame;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no task completion for ${watchId}: ${JSON.stringify(session.taskCompletes)}`);
}

async function createWatch(input: {
  text: string;
  sourceId: string;
  events: string[];
  then: Record<string, unknown>;
  sessionId?: string;
  deadlineMs?: number;
}) {
  const response = await watchesRoute.POST(new Request('http://localhost/api/symon/watches', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: input.sessionId ?? 'symon-session-test',
      condition: {
        text: input.text,
        source: 'packet',
        id: input.sourceId,
        events: input.events,
        repoPath,
      },
      then: input.then,
      ...(input.deadlineMs ? { deadlineMs: input.deadlineMs } : {}),
    }),
  }));
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json() as { watch: { id: string; state: string } }).watch;
}

function firePacketEvent(packetId: string, eventLabel: string): void {
  const lane = createLane({
    repoPath,
    branch: `packet/${packetId}`,
    baseBranch: 'main',
    runtime: 'codex',
    packetId,
  });
  recordLaneEvent(lane.id, 'update', 'system', { eventLabel });
}

beforeAll(async () => {
  wsProcess = execFile(process.execPath, [
    '--import=./scripts/register-server-only-stub.mjs',
    '--import=tsx',
    'src/ws-server.ts',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CORTEX_IDE_DATA_DIR: dataDir,
      O8_DATA_DIR: dataDir,
      O8_API_PORT: String(apiPort),
      O8_WS_PORT: String(wsPort),
      // This process drives every tick, so the server's own scheduler stays out
      // of the way. Its drain-on-registration hook is NOT gated by this flag.
      O8_DISABLE_AUTOMATIONS: '1',
    },
  });
  await waitForHealth(wsPort);
}, 40_000);

afterAll(async () => {
  if (wsProcess && wsProcess.exitCode === null) {
    wsProcess.kill('SIGTERM');
    await Promise.race([once(wsProcess, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  closeSymonWatchLedger();
  closeDb();
  rmSync(repoPath, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  const sqlite = getSqlite();
  sqlite.prepare('DELETE FROM automation_fires').run();
  sqlite.prepare("DELETE FROM cloud_jobs WHERE team_id = 'automation'").run();
  sqlite.prepare('DELETE FROM automations').run();
  sqlite.prepare('DELETE FROM automation_source_events').run();
  sqlite.prepare('DELETE FROM automation_source_ingest_state').run();
  sqlite.prepare('DELETE FROM lane_events').run();
  sqlite.prepare('DELETE FROM lanes').run();
});

describe('Symon standing watches through their durable production seams', () => {
  it('reports a packet reaching its watched state to the live phone session', async () => {
    const session = await openSymonSession('symon-watch-live');
    try {
      const watch = await createWatch({
        text: 'tell me when packet ready-1 asks for review',
        sourceId: 'ready-1',
        events: ['review_requested'],
        then: { kind: 'report', say: 'Packet ready-1 is waiting on your review.' },
      });
      expect(watch.state).toBe('watching');

      firePacketEvent('ready-1', 'review_requested');
      const tick = await runAutomationSchedulerTick({
        nowMs: Date.now(),
        workerId: 'symon-watch-live-worker',
        concurrencyCap: 1,
        maxClaims: 2,
      });
      expect(tick.materialized).toHaveLength(1);
      expect(tick.completed[0]).toMatchObject({ source: 'watch', actionKind: 'symon_report' });

      const frame = await waitForTaskComplete(session, watch.id);
      expect(frame).toMatchObject({ taskId: watch.id, status: 'done', truncated: false });
      expect(String(frame.resultText)).toContain('Packet ready-1 is waiting on your review.');
      expect(String(frame.resultText)).toContain('ready-1 reached review_requested');
      expect(String(frame.intentText)).toBe('tell me when packet ready-1 asks for review');

      // One-shot: the question has been answered, so the watch closes itself.
      expect(listSymonWatches().find((entry) => entry.id === watch.id)?.state).toBe('closed');
      expect(readSymonWatchLedger(watch.id).map((entry) => entry.phase))
        .toEqual(['watch_fired', 'watch_registered']);
    } finally {
      await session.close();
    }
  }, 30_000);

  it('parks a plan-bodied watch with no session and drains it when one registers', async () => {
    const watch = await createWatch({
      text: 'when packet ship-2 merges, take the follow-up steps',
      sourceId: 'ship-2',
      events: ['merged'],
      then: {
        kind: 'plan',
        say: 'Packet ship-2 merged.',
        steps: [{ tool: 'o8_status', args: {} }],
      },
    });

    firePacketEvent('ship-2', 'merged');
    const tick = await runAutomationSchedulerTick({
      nowMs: Date.now(),
      workerId: 'symon-watch-park-worker',
      concurrencyCap: 1,
      maxClaims: 2,
    });
    expect(tick.completed[0]).toMatchObject({ source: 'watch', actionKind: 'symon_plan' });

    const parked = listSymonWatches().find((entry) => entry.id === watch.id);
    expect(parked?.state).toBe('parked');
    expect(parked?.parkedAt).toBeTypeOf('number');
    expect(readSymonWatchLedger(watch.id).map((entry) => entry.phase))
      .toEqual(['watch_parked', 'watch_registered']);

    // The phone comes back. Registration alone drains the park.
    const session = await openSymonSession('symon-watch-return');
    try {
      const frame = await waitForTaskComplete(session, watch.id);
      expect(String(frame.resultText)).toContain('Packet ship-2 merged.');
      expect(String(frame.resultText)).toContain(`symon_watch_run with that id`);
      expect(readSymonWatchLedger(watch.id).map((entry) => entry.phase)).toContain('watch_drained');

      // What symon_watch_run reads before it enters the native plan executor.
      const claim = await watchRoute.GET(new Request(`http://localhost/api/symon/watches/${watch.id}`), {
        params: Promise.resolve({ id: watch.id }),
      });
      expect(claim.status).toBe(200);
      expect(await claim.json()).toMatchObject({
        plan: { steps: [{ tool: 'o8_status' }], condition: 'when packet ship-2 merges, take the follow-up steps' },
      });

      // A denial at the confirm card closes the watch and runs nothing.
      const denied = await watchRoute.PATCH(new Request(`http://localhost/api/symon/watches/${watch.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runOutcome: 'denied', detail: 'operator declined the card' }),
      }), { params: Promise.resolve({ id: watch.id }) });
      expect(denied.status).toBe(200);
      expect(listSymonWatches().find((entry) => entry.id === watch.id)).toMatchObject({
        state: 'closed',
        lastErrorMessage: 'Watch plan was declined by the operator.',
      });
      expect(readSymonWatchLedger(watch.id).find((entry) => entry.phase === 'watch_ran'))
        .toMatchObject({ outcome: 'denied' });
    } finally {
      await session.close();
    }
  }, 30_000);

  it('survives a process restart and still fires from its checkpoint', async () => {
    const watch = await createWatch({
      text: 'tell me when packet restart-3 finishes',
      sourceId: 'restart-3',
      events: ['exit_clean'],
      then: { kind: 'report', say: 'Packet restart-3 finished.' },
    });

    // Every handle this process holds goes away; only SQLite carries the watch.
    closeDb();
    closeSymonWatchLedger();

    firePacketEvent('restart-3', 'exit_clean');
    const tick = await runAutomationSchedulerTick({
      nowMs: Date.now(),
      workerId: 'symon-watch-restart-worker',
      concurrencyCap: 1,
      maxClaims: 2,
    });
    expect(tick.materialized).toHaveLength(1);
    expect(tick.completed[0]).toMatchObject({ automationId: watch.id, actionKind: 'symon_report' });
    expect(listAutomationFires(watch.id)).toHaveLength(1);
  }, 30_000);

  it('expires a watch past its deadline with a ledger entry and no fire', async () => {
    const watch = await createWatch({
      text: 'tell me when packet late-4 lands',
      sourceId: 'late-4',
      events: ['merged'],
      then: { kind: 'report', say: 'Packet late-4 landed.' },
      deadlineMs: 60_000,
    });

    firePacketEvent('late-4', 'merged');
    const tick = await runAutomationSchedulerTick({
      nowMs: Date.now() + 61_000,
      workerId: 'symon-watch-expiry-worker',
      concurrencyCap: 1,
      maxClaims: 2,
    });
    expect(tick.materialized.filter((fire) => fire.automationId === watch.id)).toHaveLength(0);
    expect(listAutomationFires(watch.id)).toHaveLength(0);
    expect(listSymonWatches().find((entry) => entry.id === watch.id)).toMatchObject({
      state: 'closed',
      lastErrorMessage: 'Watch expired.',
    });
    expect(readSymonWatchLedger(watch.id).map((entry) => entry.phase))
      .toEqual(['watch_expired', 'watch_registered']);
  }, 30_000);
});
