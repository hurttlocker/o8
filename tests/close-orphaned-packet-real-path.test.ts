import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { bindOwnedPacketSession } from './helpers/managed-packet-worktree';

const root = mkdtempSync(path.join(os.tmpdir(), 'o8-orphan-close-'));
const token = 'orphan-close-operator-fixture';
const sessionRoot = path.join(root, 'sessions');
process.env.O8_DATA_DIR = root;
process.env.CORTEX_IDE_DATA_DIR = root;
process.env.O8_WORKTREE_ROOT = path.join(root, 'worktrees');
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = sessionRoot;
writeFileSync(path.join(root, 'ws-token'), token);
const route = await import('@/app/api/orchestrator/discard-packet/route');
const { closeDb } = await import('@/lib/db');
const { createLane, getLane, setLaneStatus } = await import('@/lib/lane/registry');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { resetOwnedSessionIndex } = await import('@/lib/runtimes/shared/owned-session-index');
const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
const { captureWorktreeMaterializationIdentity } = await import('@/lib/worktree/materialization-identity');
const { resolveWorktreeRootLayout } = await import('@/lib/worktree/root-layout');
const { addRepo } = await import('@/lib/repos/registry');
const { archiveRootForOwnedSessionRoot } = await import('@/lib/runtimes/shared/owned-session/archive');
const { handleClosePacketUnmerged } = await import('@/lib/mcp/operator-handlers/close-packet');
const { setApiBase } = await import('@/lib/mcp/operator-handlers/shared');
const { exactSnapshot } = await import('@/lib/workspace/workspace-materialization-retirement');
let server: Server;
let base: string;
const children = new Set<ChildProcess>();

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

type SessionState = 'archived' | 'missing' | 'unbound';
async function fixture(sessionState: SessionState) {
  const packetId = `pkt-${randomUUID()}`;
  const repoPath = path.join(root, packetId);
  mkdirSync(repoPath);
  git(repoPath, 'init', '-q', '-b', 'main');
  git(repoPath, 'config', 'user.name', 'o8-test');
  git(repoPath, 'config', 'user.email', 'o8@example.test');
  writeFileSync(path.join(repoPath, 'source.txt'), 'base\n');
  git(repoPath, 'add', 'source.txt');
  git(repoPath, 'commit', '-qm', 'base');
  const branch = `fix/${packetId}`;
  await addRepo(repoPath);
  const worktreeId = `packet-${packetId}`;
  const worktreePath = path.join(resolveWorktreeRootLayout(repoPath).primaryBase, worktreeId);
  mkdirSync(path.dirname(worktreePath), { recursive: true });
  git(repoPath, 'worktree', 'add', '-qb', branch, worktreePath);
  const materializationIdentity = await captureWorktreeMaterializationIdentity(worktreePath);
  const materializationParentIdentity = await captureWorktreeMaterializationIdentity(path.dirname(worktreePath));
  await withWorktreeMetaTransaction(repoPath, (transaction) => transaction.save(worktreeId, {
    id: worktreeId, packetId, agentType: 'codex', baseBranch: 'main', createdAt: Date.now(),
    claudeManaged: false, taskName: packetId, branchName: branch, status: 'ready',
    isolationKind: 'git-worktree', materializationIdentity, materializationParentIdentity,
  }));
  const sessionKey = await bindOwnedPacketSession(repoPath, { id: worktreeId, path: worktreePath }, { packetId, branch });
  const worktree = { id: worktreeId, path: worktreePath, sessionKey };
  writeFileSync(path.join(worktree.path, 'source.txt'), 'completed work\n');
  git(worktree.path, 'commit', '-qam', 'completed work');
  const head = git(worktree.path, 'rev-parse', 'HEAD');
  const lane = createLane({
    repoPath, worktreePath: worktree.path, branch, baseBranch: 'main', runtime: 'codex',
    packetId, sessionKey: sessionState === 'unbound' ? undefined : worktree.sessionKey,
    ownership: 'managed',
  });
  setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
  if (sessionState === 'archived') {
    const archive = archiveRootForOwnedSessionRoot(sessionRoot);
    mkdirSync(archive, { recursive: true });
    renameSync(path.join(sessionRoot, `codex-owned-${packetId}`), path.join(archive, `codex-owned-${packetId}`));
  } else {
    rmSync(path.join(sessionRoot, `codex-owned-${packetId}`), { recursive: true });
    if (sessionState === 'unbound') {
      await withWorktreeMetaTransaction(repoPath, async (transaction) => {
        const metadata = (await transaction.readAll())[worktree.id];
        await transaction.save(worktree.id, { ...metadata, sessionKey: undefined });
      });
    }
  }
  resetOwnedSessionIndex();
  writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(), missionId: `mission-${packetId}`, repoPath,
    runtime: 'codex', updatedAt: new Date().toISOString(),
    packets: [{
      id: packetId, referenceLabel: '#4080', title: 'Close an orphaned review packet',
      summary: 'Close persisted review state without a live worker.', workspaceTargetPath: repoPath,
      branchTarget: branch, runtime: 'codex', dependencyLabels: [], dependencyPacketIds: [],
      queueState: 'held', releaseState: 'pending', status: 'awaiting_review', blockedReason: null,
      lane: { tileId: lane.id, tabId: lane.id, laneId: lane.id, repoPath,
        worktreePath: worktree.path, runtime: 'codex', sessionKey: lane.sessionKey }, review: null,
    } as OrchestratorPacket],
  });
  return { packetId, repoPath, branch, worktree, lane, head };
}

async function httpClose(packetId: string) {
  return fetch(`${base}/api/orchestrator/discard-packet`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ packetId, disposition: 'superseded', clientMutationId: randomUUID() }),
  });
}

async function cliClose(packetId: string, command = 'close') {
  const child = spawn(process.execPath, [path.join(process.cwd(), 'cli/dist/o8.mjs'),
    'packet', command, packetId, '--reason', 'superseded', '--json'], {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: '', O8_API_PORT: new URL(base).port, O8_API_TOKEN: token,
      O8_WORKER_TOKEN: '', O8_WORKER_PACKET_ID: '', O8_PACKET_ID: '', O8_LANE_ID: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [exitCode] = await once(child, 'close');
  return { exitCode, stdout, stderr };
}

beforeAll(async () => {
  execFileSync(process.execPath, ['cli/esbuild.config.mjs'], { cwd: process.cwd(), stdio: 'pipe' });
  server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const url = new URL(request.url ?? '/', base);
      const next = new NextRequest(url, { method: request.method,
        headers: request.headers as HeadersInit,
        body: chunks.length ? Buffer.concat(chunks).toString() : undefined });
      let result: Response;
      if (url.pathname === '/api/orchestrator/discard-packet') result = await route.POST(next);
      else if (url.pathname === '/api/setup/status') result = (await import('@/app/api/setup/status/route')).GET();
      else if (url.pathname === '/api/lanes') result = await (await import('@/app/api/lanes/route')).GET(next);
      else result = Response.json({ error: 'Unknown route' }, { status: 404 });
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(await result.text());
    } catch (error) {
      response.writeHead(500);
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture server address.');
  base = `http://127.0.0.1:${address.port}`;
  writeFileSync(path.join(root, 'api-port'), String(address.port));
  setApiBase(base);
});

afterAll(async () => {
  for (const child of children) {
    const exited = once(child, 'close');
    child.kill();
    await exited;
  }
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

describe('orphaned review packet close through persisted HTTP, CLI and MCP entry points (#4080)', () => {
  for (const sessionState of ['archived', 'missing', 'unbound'] as const) {
    for (const entry of ['http', 'cli'] as const) {
      it(`${entry} retires a clean checkout with ${sessionState} session truth and preserves its commits`, async () => {
        const source = await fixture(sessionState);
        if (entry === 'http') {
          const response = await httpClose(source.packetId);
          const body = await response.json();
          expect(body, JSON.stringify(body)).toMatchObject({ ok: true, result: { closed: true, worktreeRemoved: true } });
          expect(response.status).toBe(200);
        } else {
          const result = await cliClose(source.packetId, sessionState === 'unbound' ? 'discard' : 'close');
          expect(result, result.stderr).toMatchObject({ exitCode: 0 });
        }
        expect(getLane(source.lane.id)?.status).toBe('archived');
        expect(readOrchestratorControlPlaneState().packets[0]?.status).toBe('archived');
        expect(existsSync(source.worktree.path)).toBe(false);
        expect(git(source.repoPath, 'rev-parse', source.branch)).toBe(source.head);
        expect(exactSnapshot(source.worktree.path)?.state).toBe('retired');
      });
    }
  }

  it('HTTP, CLI and MCP refuse a live orphan process with the same code and message', async () => {
    const source = await fixture('missing');
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(() => {}, 1000)'], {
      cwd: source.worktree.path, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    await once(child.stdout!, 'data');
    const response = await httpClose(source.packetId);
    const body = await response.json();
    const cli = await cliClose(source.packetId);
    const mcp = await handleClosePacketUnmerged({ packetId: source.packetId, disposition: 'superseded' });
    expect(response.status).toBe(409);
    expect(body.error.message).toContain(String(child.pid));
    expect(cli.exitCode).not.toBe(0);
    const cliError = JSON.parse(cli.stderr.trim()).error;
    expect(cliError).toMatchObject(body.error);
    expect(mcp.isError).toBe(true);
    expect(mcp.content[0]?.type).toBe('text');
    expect(JSON.parse((mcp.content[0] as { text: string }).text)).toMatchObject({ error: body.error });
    expect(getLane(source.lane.id)?.status).not.toBe('archived');
    expect(existsSync(source.worktree.path)).toBe(true);
    const exited = once(child, 'close');
    child.kill();
    await exited;
    children.delete(child);
    const retry = await httpClose(source.packetId);
    expect(await retry.json()).toMatchObject({ ok: true, result: { closed: true } });
    expect(existsSync(source.worktree.path)).toBe(false);
  });
});
