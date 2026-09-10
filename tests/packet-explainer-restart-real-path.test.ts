import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const backendMocks = vi.hoisted(() => ({ sendTurn: vi.fn() }));
vi.mock('@/lib/lane/orchestrator-backends/registry', () => {
  const backend = { id: 'codex', label: 'Fixture',
    ensureSession: () => ({ status: 'ready' }), sendTurn: backendMocks.sendTurn };
  return { getActiveReviewerBackend: () => backend, getOrchestratorBackend: () => backend };
});

const dataDir = mkdtempSync(join(tmpdir(), 'o8-explainer-restart-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
const { getSqlite } = await import('@/lib/db');
const { createLane } = await import('@/lib/lane/registry');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { enqueuePacketExplainer, drainPacketExplainerQueue, startPacketExplainerQueueDrain } =
  await import('@/lib/lane/packet-explainer-queue');
const { createOrchestratorTurnRecord, finishOrchestratorTurn, isPidAlive } =
  await import('@/lib/lane/orchestrator-crash-survival');
const { sessionNameForRepo } = await import('@/lib/lane/orchestrator-session-core');
const { listArtifacts } = await import('@/lib/artifacts/store');
const { explainerThreadId, ownsCurrentExplainer } = await import('@/lib/lane/packet-explainer-ownership');
const children: ChildProcess[] = [];
const providerPids: number[] = [];

beforeAll(async () => { await updateOperatorDefaults({ packetExplainerEnabled: true }); });
afterAll(() => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (const pid of providerPids) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* fixture already gone */ }
  }
  rmSync(dataDir, { recursive: true, force: true });
});

async function enqueue(label: string) {
  const lane = createLane({ label, repoPath: dataDir, worktreePath: dataDir,
    branch: `inline/${label}`, runtime: 'codex', packetId: `packet-${label}` });
  const id = await enqueuePacketExplainer({ lane, packetId: lane.packetId!, packetTitle: label,
    packetSummary: '', diffSummary: '', changedFileCount: 1, deviationsRaw: null, reviewContext: '' });
  return { lane, id };
}

function queueRow(id: string | null) {
  return getSqlite().prepare('SELECT * FROM explainer_queue WHERE id = ?').get(id) as {
    id: string; packet_id: string; lane_id: string; repo_path: string;
    claim_owner: string; status: string; outcome: string;
  };
}

function completedReport() {
  backendMocks.sendTurn.mockImplementation(async (repo: string, prompt: string) => {
    const filename = /named exactly `([^`]+)`/.exec(prompt)![1];
    writeFileSync(join(repo, filename), '<html>Recovered report</html>');
  });
}

describe('explainer process and durable queue restart contract', () => {
  it('does not reclaim after owner SIGKILL until its detached provider has exited', async () => {
    const { lane, id } = await enqueue('abrupt-restart');
    const host = spawn(process.execPath, [
      '--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
      'tests/fixtures/explainer-crash-host.ts',
    ], {
      cwd: resolve('.'), env: { ...process.env, CORTEX_IDE_DATA_DIR: dataDir, O8_DATA_DIR: dataDir },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    children.push(host);
    let stderr = '';
    host.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    const message = await new Promise<{ providerPid: number }>((resolveMessage, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Fixture did not start: ${stderr}`)), 8_000);
      host.once('message', (value) => { clearTimeout(timeout); resolveMessage(value as { providerPid: number }); });
      host.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Fixture exited ${code}: ${stderr}`)); });
    });
    providerPids.push(message.providerPid);
    const owner = queueRow(id).claim_owner;
    completedReport();
    backendMocks.sendTurn.mockClear();
    await drainPacketExplainerQueue();
    expect(backendMocks.sendTurn).not.toHaveBeenCalled();
    expect(queueRow(id).claim_owner).toBe(owner);
    const closed = once(host, 'exit');
    host.kill('SIGKILL');
    await closed;
    expect(isPidAlive(message.providerPid)).toBe(true);
    completedReport();
    backendMocks.sendTurn.mockClear();
    const stop = startPacketExplainerQueueDrain();
    await drainPacketExplainerQueue();
    stop();
    expect(queueRow(id)).toMatchObject({ status: 'in_progress', claim_owner: owner });
    expect(backendMocks.sendTurn).not.toHaveBeenCalled();

    process.kill(-message.providerPid, 'SIGTERM');
    await vi.waitFor(() => expect(isPidAlive(message.providerPid)).toBe(false));
    await drainPacketExplainerQueue();
    expect(backendMocks.sendTurn).toHaveBeenCalledOnce();
    expect(queueRow(id)).toMatchObject({ status: 'completed', outcome: 'ready' });
    expect(listArtifacts({ packetId: lane.packetId! })).toHaveLength(1);
  });

  it('keeps an aborted claim until provider exit, even if its ledger already says completed', async () => {
    const { id } = await enqueue('normal-restart');
    const provider = spawn(process.execPath, ['-e', `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      process.send({ childPid: child.pid });
      setInterval(() => {}, 1000);
    `], {
      detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    children.push(provider);
    providerPids.push(provider.pid!);
    const [descendant] = await once(provider, 'message') as [{ childPid: number }];
    let started!: () => void;
    const ready = new Promise<void>((resolveReady) => { started = resolveReady; });
    backendMocks.sendTurn.mockImplementationOnce(async (repo, _prompt, _onEvent, options) => {
      const record = createOrchestratorTurnRecord({ backend: 'codex', repoPath: repo,
        sessionName: sessionNameForRepo('cortex-codex-orchestrator', repo, options.threadId),
        threadId: options.threadId, pid: provider.pid! });
      started();
      await new Promise<void>((resolveAbort) => options.signal.addEventListener('abort', () => {
        finishOrchestratorTurn(record, 'completed');
        resolveAbort();
      }, { once: true }));
    });
    const stop = startPacketExplainerQueueDrain();
    await ready;
    stop();
    await vi.waitFor(() => expect(queueRow(id).outcome).toBe('awaiting_exit'));
    const priorCalls = backendMocks.sendTurn.mock.calls.length;
    await drainPacketExplainerQueue();
    expect(queueRow(id).status).toBe('in_progress');
    expect(backendMocks.sendTurn).toHaveBeenCalledTimes(priorCalls);
    const exited = once(provider, 'exit');
    provider.kill('SIGTERM');
    await exited;
    expect(isPidAlive(descendant.childPid)).toBe(true);
    await drainPacketExplainerQueue();
    expect(queueRow(id).status).toBe('in_progress');
    expect(backendMocks.sendTurn).toHaveBeenCalledTimes(priorCalls);
    process.kill(-provider.pid!, 'SIGTERM');
    await vi.waitFor(() => expect(isPidAlive(descendant.childPid)).toBe(false));
    completedReport();
    await drainPacketExplainerQueue();
    expect(queueRow(id)).toMatchObject({ status: 'completed', outcome: 'ready' });
  });

  it('does not publish a superseded report and gives the successor a distinct session and file', async () => {
    const { lane, id } = await enqueue('superseded');
    let successorId: string | null = null;
    let priorClaim: ReturnType<typeof queueRow> | null = null;
    backendMocks.sendTurn.mockImplementationOnce(async (repo, prompt) => {
      priorClaim = queueRow(id);
      const filename = /named exactly `([^`]+)`/.exec(prompt)![1];
      writeFileSync(join(repo, filename), '<html>Stale</html>');
      successorId = await enqueuePacketExplainer({ lane, packetId: lane.packetId!, packetTitle: 'Successor',
        packetSummary: '', diffSummary: '', changedFileCount: 2, deviationsRaw: null, reviewContext: '' });
    });
    await drainPacketExplainerQueue();
    expect(listArtifacts({ packetId: lane.packetId! })).toHaveLength(0);
    expect(queueRow(id).outcome).toBe('superseded');
    expect(ownsCurrentExplainer(priorClaim!)).toBe(false);
    const staleThread = explainerThreadId(priorClaim!);
    completedReport();
    await drainPacketExplainerQueue();
    expect(queueRow(successorId).status).toBe('completed');
    expect(backendMocks.sendTurn.mock.lastCall?.[3].threadId).not.toBe(staleThread);
    expect(listArtifacts({ packetId: lane.packetId! })).toHaveLength(1);
  });

  it('does not start queued work while the existing setting is off', async () => {
    const { id } = await enqueue('disabled');
    await updateOperatorDefaults({ packetExplainerEnabled: false });
    backendMocks.sendTurn.mockClear();
    await drainPacketExplainerQueue();
    expect(backendMocks.sendTurn).not.toHaveBeenCalled();
    expect(queueRow(id).status).toBe('pending');
    await updateOperatorDefaults({ packetExplainerEnabled: true });
    completedReport();
    await drainPacketExplainerQueue();
    expect(queueRow(id).status).toBe('completed');
  });

  it('keeps a failed launch with an unconfirmed PID fenced instead of retrying it', async () => {
    const { id } = await enqueue('unconfirmed-launch');
    backendMocks.sendTurn.mockImplementationOnce(async (repo, _prompt, _onEvent, options) => {
      createOrchestratorTurnRecord({ backend: 'codex', repoPath: repo,
        sessionName: sessionNameForRepo('cortex-codex-orchestrator', repo, options.threadId),
        threadId: options.threadId, pid: 0 });
      throw new Error('provider identity persistence interrupted');
    });
    await drainPacketExplainerQueue();
    expect(queueRow(id)).toMatchObject({ status: 'in_progress', outcome: 'awaiting_exit' });
    const calls = backendMocks.sendTurn.mock.calls.length;
    await drainPacketExplainerQueue();
    expect(backendMocks.sendTurn).toHaveBeenCalledTimes(calls);
    getSqlite().prepare('DELETE FROM explainer_queue WHERE id = ?').run(id);
  });

  it('holds an orphan claim without process evidence rather than guessing that it is dead', async () => {
    const { id } = await enqueue('unknown-exit');
    const owner = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    children.push(owner);
    await once(owner, 'exit');
    getSqlite().prepare(`UPDATE explainer_queue SET status = 'in_progress', claim_owner = ? WHERE id = ?`)
      .run(`explainer-owner-${owner.pid}-missing`, id);
    // Separate repo identity keeps unrelated completed fixture ledgers out of this check.
    getSqlite().prepare('UPDATE explainer_queue SET repo_path = ? WHERE id = ?').run(join(dataDir, 'unknown'), id);
    backendMocks.sendTurn.mockClear();
    const stop = startPacketExplainerQueueDrain();
    await drainPacketExplainerQueue();
    stop();
    expect(queueRow(id).status).toBe('in_progress');
    expect(backendMocks.sendTurn).not.toHaveBeenCalled();
  });
});
