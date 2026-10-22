import { execFileSync, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

vi.mock('@/lib/runtimes/shared/dispatch-readiness', async (original) => ({
  ...await original<typeof import('@/lib/runtimes/shared/dispatch-readiness')>(),
  ensureDispatchBackendReady: async () => ({ ready: true }),
}));
vi.mock('@/lib/lane/terminal-lane-cleanup', () => ({ scheduleTerminalLaneCleanup: vi.fn() }));

const root = mkdtempSync(path.join(os.tmpdir(), 'o8-finished-retirement-'));
const dataDir = path.join(root, 'data');
const token = 'preservation-operator-test-token';
const workerToken = 'preservation-worker-test-token';
mkdirSync(dataDir);
writeFileSync(path.join(dataDir, 'ws-token'), token);
writeFileSync(path.join(dataDir, 'worker-token'), workerToken);
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_WORKTREE_ROOT = path.join(dataDir, 'worktrees');
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = path.join(root, 'sessions');
const fakeCodex = path.join(root, 'fake-codex');
const spawnReceipt = path.join(root, 'unexpected-spawn');
writeFileSync(fakeCodex, '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "codex-cli 0.130.0\\n"; exit 0; fi\nprintf unexpected > "' + spawnReceipt + '"\nexit 17\n', { mode: 0o700 });
process.env.O8_CODEX_BIN = fakeCodex;

const lanesRoute = await import('@/app/api/lanes/route');
const { closeDb } = await import('@/lib/db');
const { createLane, getLane, setLaneStatus } = await import('@/lib/lane/registry');
const { addRepo } = await import('@/lib/repos/registry');
const { WorktreeManager } = await import('@/lib/worktree/manager');
const { captureWorktreeMaterializationIdentity } = await import('@/lib/worktree/materialization-identity');
const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
const { resolveWorktreeRootLayout } = await import('@/lib/worktree/root-layout');
const { getWorkspaceSnapshot } = await import('@/lib/worktree/snapshot-state');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { recordMission } = await import('@/lib/db/missions-store');
const repoPath = path.join(root, 'repo');
let server: Server;
let port = 0;
let finished = false;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function ownedWorkspace(repo: Awaited<ReturnType<typeof addRepo>>, packetId: string, revision: string) {
  const worktreeId = 'packet-' + packetId;
  const branch = 'codex/' + packetId;
  const workspacePath = path.join(resolveWorktreeRootLayout(repo.localPath).primaryBase, worktreeId);
  mkdirSync(path.dirname(workspacePath), { recursive: true });
  git(repo.localPath, 'clone', '--quiet', '--no-hardlinks', '--no-checkout', repo.localPath, workspacePath);
  git(workspacePath, 'config', 'user.name', 'o8 regression');
  git(workspacePath, 'config', 'user.email', 'o8@example.test');
  git(workspacePath, 'checkout', '-qb', branch, revision);
  const identity = await captureWorktreeMaterializationIdentity(workspacePath);
  const parentIdentity = await captureWorktreeMaterializationIdentity(path.dirname(workspacePath));
  const surfaceId = 'codex-owned:codex-owned-' + packetId;
  const sessionDir = path.join(root, 'sessions', 'codex-owned-' + packetId);
  mkdirSync(sessionDir, { recursive: true });
  const session: OwnedSessionRecord = {
    surfaceId, packetId, sessionDir, cwd: workspacePath, repoPath: workspacePath,
    branch, head: git(workspacePath, 'rev-parse', 'HEAD'), title: 'Preservation regression owned session',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), recentRuns: [],
    latestPrompt: 'Verify retained source and selected artifact recovery.', latestSummary: 'Owned idle recovery fixture.',
    runIdentityLedger: { version: 1, totalRuns: 0, complete: true },
    workspaceBinding: {
      logicalWorkspaceId: 'packet:' + packetId, repositoryUuid: repo.id, packetId,
      cwd: workspacePath, version: 1, verifiedAt: new Date().toISOString(),
    },
    threadId: '12345678-1234-1234-1234-123456789abc',
    laneId: undefined,
  };
  writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(session), { mode: 0o600 });
  const { resetOwnedSessionIndex } = await import('@/lib/runtimes/shared/owned-session-index');
  resetOwnedSessionIndex();
  await withWorktreeMetaTransaction(repo.localPath, (transaction) => transaction.save(worktreeId, {
    id: worktreeId, agentType: 'codex', sessionKey: surfaceId, baseBranch: 'main', createdAt: Date.now(),
    claudeManaged: false, taskName: packetId, branchName: branch, status: 'ready', isolationKind: 'apfs-cow-clone',
    materializationIdentity: identity, materializationParentIdentity: parentIdentity,
  }));
  const lane = createLane({
    repoPath: repo.localPath, worktreePath: workspacePath, branch, baseBranch: 'main', runtime: 'codex',
    packetId, sessionKey: surfaceId, ownership: 'managed',
  });
  setLaneStatus(lane.id, 'reviewing');
  return { worktreeId, workspacePath, lane, identity };
}

function cli(args: string[], bearer = token): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env, O8_API_PORT: String(port), O8_API_TOKEN: bearer,
      O8_WORKER_TOKEN: '', O8_WORKER_PACKET_ID: '',
    };
    delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, [path.join(process.cwd(), 'cli/dist/o8.mjs'), ...args], {
      cwd: repoPath, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

beforeAll(async () => {
  mkdirSync(repoPath);
  git(repoPath, 'init', '-q', '-b', 'main');
  git(repoPath, 'config', 'user.name', 'o8 regression');
  git(repoPath, 'config', 'user.email', 'o8@example.test');
  writeFileSync(path.join(repoPath, '.gitignore'), '.o8/\nnode_modules/\n');
  writeFileSync(path.join(repoPath, 'tracked.txt'), 'base source\n');
  git(repoPath, 'add', '.gitignore', 'tracked.txt');
  git(repoPath, 'commit', '-qm', 'base');
  execFileSync(process.execPath, [path.join(process.cwd(), 'cli/esbuild.config.mjs')], { stdio: 'pipe' });
  server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const next = new NextRequest(new URL(request.url ?? '/', 'http://127.0.0.1:' + port), {
        method: request.method, headers: request.headers as HeadersInit,
        body: chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined,
      });
      let route: Response;
      if (next.nextUrl.pathname === '/api/setup/status') route = (await import('@/app/api/setup/status/route')).GET();
      else if (next.nextUrl.pathname === '/api/lanes') {
        route = request.method === 'POST' ? await lanesRoute.POST(next) : await lanesRoute.GET(next);
      } else if (next.nextUrl.pathname === '/api/orchestrator/discard-packet') {
        route = await (await import('@/app/api/orchestrator/discard-packet/route')).POST(next);
      } else route = Response.json({ ok: false, error: 'Unknown route' }, { status: 404 });
      response.writeHead(route.status, { 'content-type': 'application/json' });
      response.end(await route.text());
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Regression server did not bind.');
  port = address.port;
  process.env.O8_API_PORT = String(port);
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  closeDb();
  if (finished) rmSync(root, { recursive: true, force: true });
});


async function finishedPacket(packetId: string, status: 'archived' | 'completed' | 'failed' | 'reviewing' = 'archived') {
  const repo = await addRepo(repoPath);
  const source = await ownedWorkspace(repo, packetId, 'main');
  writeFileSync(path.join(source.workspacePath, 'tracked.txt'), 'completed source\n');
  git(source.workspacePath, 'commit', '-qam', 'completed source');
  const head = git(source.workspacePath, 'rev-parse', 'HEAD');
  setLaneStatus(source.lane.id, status);
  rmSync(path.join(root, 'sessions', 'codex-owned-' + packetId), { recursive: true });
  const { resetOwnedSessionIndex } = await import('@/lib/runtimes/shared/owned-session-index');
  resetOwnedSessionIndex();
  const mission = writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(), missionId: 'mission-' + packetId,
    repoPath, runtime: 'codex', updatedAt: new Date().toISOString(),
    packets: [{ id: packetId, referenceLabel: '#4199', title: 'Retire finished checkout',
      summary: 'Remove preserved clean checkout.', workspaceTargetPath: repoPath,
      branchTarget: source.lane.branch, runtime: 'codex', dependencyLabels: [], dependencyPacketIds: [],
      queueState: 'held', releaseState: 'pending', status: status === 'reviewing' ? 'awaiting_review' : 'archived',
      ...(status === 'reviewing' ? {} : { archivedAt: new Date().toISOString() }),
      blockedReason: null, review: null,
      lane: { tileId: source.lane.id, tabId: source.lane.id, laneId: source.lane.id,
        repoPath, worktreePath: source.workspacePath, runtime: 'codex', sessionKey: source.lane.sessionKey },
    } as OrchestratorPacket],
  });
  recordMission({ id: mission.missionId!, repoPath, runtime: 'codex', prompt: '', summary: '',
    constraints: '', totalWaves: 1, missionState: mission,
    packetMeta: mission.packets.map(({ id, title, referenceLabel }) => ({ id, title, referenceLabel })),
  });
  return { repo, source, head };
}

describe('finished packet checkout retirement', () => {
  it('compiled packet close retires a clean archived clone with a missing session and no legacy run ledger', async () => {
    const { repo, source, head } = await finishedPacket('finished-missing-session');
    const closed = await cli(['packet', 'close', 'finished-missing-session', '--reason', 'superseded']);
    expect(closed.exitCode, closed.stderr + closed.stdout).toBe(0);
    expect(existsSync(source.workspacePath)).toBe(false);
    const snapshot = getWorkspaceSnapshot(repo.id, 'finished-missing-session')!;
    expect(snapshot).toMatchObject({ state: 'retired', headCommit: head });
    expect(git(repoPath, 'rev-parse', snapshot.recoveryRef)).toBe(head);
    finished = true;
  }, 120_000);

  it.each(['completed', 'failed'] as const)('archive route waits for retirement of a clean %s packet whose session is gone', async (status) => {
    const packetId = 'finished-archive-' + status;
    const { repo, source, head } = await finishedPacket(packetId, status);
    const response = await fetch('http://127.0.0.1:' + port + '/api/lanes', {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ verb: 'archive', laneId: source.lane.id }),
    });
    expect(response.status, await response.text()).toBe(200);
    expect(existsSync(source.workspacePath)).toBe(false);
    expect(getLane(source.lane.id)).toMatchObject({ status: 'archived', worktreePath: null });
    expect(getWorkspaceSnapshot(repo.id, packetId)).toMatchObject({ state: 'retired', headCommit: head });
    finished = true;
  }, 120_000);

  it('terminal manager cleanup retires a missing-session checkout without explicit Close authority', async () => {
    const { repo, source, head } = await finishedPacket('finished-background', 'completed');
    expect(await new WorktreeManager(repo.localPath).cleanup(source.worktreeId)).toBe(true);
    expect(existsSync(source.workspacePath)).toBe(false);
    expect(getWorkspaceSnapshot(repo.id, 'finished-background')).toMatchObject({ state: 'retired', headCommit: head });
    finished = true;
  }, 120_000);

  it('retries a transient cwd holder before closing', async () => {
    const { source } = await finishedPacket('finished-transient');
    const holder = spawn(process.execPath, ['-e', 'process.stdout.write("ready");process.stdin.once("data", () => setTimeout(() => process.exit(0), 350))'], {
      cwd: source.workspacePath, stdio: ['pipe', 'pipe', 'pipe'],
    });
    await new Promise(resolve => holder.stdout.once('data', resolve));
    const probes = await import('@/lib/runtime/process-open-files-snapshot');
    const read = probes.readCloseOpenFiles;
    const observed = vi.spyOn(probes, 'readCloseOpenFiles').mockImplementationOnce(async () => {
      const raw = await read();
      expect(raw).toContain('p' + holder.pid + '\n');
      holder.stdin.write('release');
      return raw;
    });
    try {
      const closed = await cli(['packet', 'close', 'finished-transient', '--reason', 'superseded']);
      expect(closed.exitCode, closed.stderr + closed.stdout).toBe(0);
      expect(observed.mock.calls.length).toBeGreaterThan(1);
      expect(existsSync(source.workspacePath)).toBe(false);
    } finally {
      observed.mockRestore();
      if (holder.exitCode === null) holder.kill();
    }
    finished = true;
  }, 120_000);

  it('keeps dirty source and does not auto-commit it on close', async () => {
    const { source, head } = await finishedPacket('finished-dirty');
    writeFileSync(path.join(source.workspacePath, 'tracked.txt'), 'unfinished edits\n');
    const closed = await cli(['packet', 'close', 'finished-dirty', '--reason', 'superseded']);
    expect(closed.exitCode).not.toBe(0);
    expect(readFileSync(path.join(source.workspacePath, 'tracked.txt'), 'utf8')).toBe('unfinished edits\n');
    expect(git(source.workspacePath, 'rev-parse', 'HEAD')).toBe(head);
    finished = true;
  }, 120_000);

  it('retains a persistent holder and a null retained run marker', async () => {
    const { source } = await finishedPacket('finished-live-holder');
    const holder = spawn(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(() => {}, 1000)'], {
      cwd: source.workspacePath, stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise(resolve => holder.stdout.once('data', resolve));
    try {
      expect((await cli(['packet', 'close', 'finished-live-holder', '--reason', 'superseded'])).exitCode).not.toBe(0);
      expect(existsSync(source.workspacePath)).toBe(true);
    } finally {
      const closed = new Promise(resolve => holder.once('close', resolve));
      holder.kill(); await closed;
    }
    const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
    const { getSqlite } = await import('@/lib/db');
    mintPacketWorkerToken('finished-live-holder', { processMarker: 'finished-null-marker' });
    getSqlite().prepare(`UPDATE worker_tokens SET lease_process_marker = NULL,
      lease_process_pid = 2147483000, lease_process_group_id = 2147483000 WHERE packet_id = ?`)
      .run('finished-live-holder');
    expect((await cli(['packet', 'close', 'finished-live-holder', '--reason', 'superseded'])).exitCode).not.toBe(0);
    expect(existsSync(source.workspacePath)).toBe(true);
    finished = true;
  }, 120_000);

  it('retains an argv-only legacy worker whose cwd is outside the checkout', async () => {
    const { source } = await finishedPacket('finished-argv-holder');
    const holder = spawn(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(() => {}, 1000)', source.workspacePath], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise(resolve => holder.stdout.once('data', resolve));
    try {
      const closed = await cli(['packet', 'close', 'finished-argv-holder', '--reason', 'superseded']);
      expect(closed.exitCode).not.toBe(0);
      expect(existsSync(source.workspacePath)).toBe(true);
    } finally {
      const closed = new Promise(resolve => holder.once('close', resolve));
      holder.kill(); await closed;
    }
    finished = true;
  }, 120_000);

  it('does not detach nonexistent session metadata after acknowledged external checkout removal', async () => {
    const { source, head } = await finishedPacket('finished-already-absent', 'reviewing');
    // Retain the source before simulating the operator's earlier external removal.
    git(repoPath, 'fetch', source.workspacePath, '+HEAD:refs/heads/preserved/finished-already-absent');
    expect(git(repoPath, 'rev-parse', 'preserved/finished-already-absent')).toBe(head);
    rmSync(source.workspacePath, { recursive: true });
    const closed = await cli(['packet', 'close', 'finished-already-absent', '--reason', 'superseded', '--acknowledge-missing-worktree']);
    expect(closed.exitCode, closed.stderr + closed.stdout).toBe(0);
    expect(git(repoPath, 'rev-parse', 'preserved/finished-already-absent')).toBe(head);
    finished = true;
  }, 120_000);

  it('native Rust workers share a target cache and avoid packet-local build growth', async () => {
    const repo = await addRepo(repoPath);
    mkdirSync(path.join(repoPath, 'src'));
    writeFileSync(path.join(repoPath, '.gitignore'), '.o8/\nnode_modules/\ntarget/\n');
    writeFileSync(path.join(repoPath, 'Cargo.toml'), '[package]\nname = "packet_cache_fixture"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFileSync(path.join(repoPath, 'src/main.rs'), 'fn main() { println!("cache fixture"); }\n');
    git(repoPath, 'add', '.gitignore', 'Cargo.toml', 'src/main.rs');
    git(repoPath, 'commit', '-qm', 'Rust fixture');
    const manager = new WorktreeManager(repo.localPath);
    const runtimeRoot = path.join(root, 'hook-runtime');
    const { pathToFileURL } = await import('node:url');
    execFileSync(process.execPath, ['--input-type=module', '--eval',
      `const { exportTauriSafetyHookResources } = await import(${JSON.stringify(pathToFileURL(path.join(process.cwd(), 'scripts/tauri-hook-resources.mjs')).href)}); exportTauriSafetyHookResources(process.argv[1], process.argv[2]);`,
      process.cwd(), runtimeRoot], { stdio: 'pipe' });
    const { createOwnedSessionStore } = await import('@/lib/runtimes/shared/owned-session/store');
    const { getLaneEvents } = await import('@/lib/lane/registry');
    const { repositoryCargoTargetDirectory, rebuildableCargoTargetPaths } = await import('@/lib/worktree/cargo-target-cache');
    const cache = repositoryCargoTargetDirectory(repoPath);
    process.env.O8_TEST_RUST_WORKER = process.execPath;
    const disk = (target: string) => Number(execFileSync('du', ['-sk', target], { encoding: 'utf8' }).split(/\s+/)[0]) * 1024;
    let before = 0;
    const receipts: Array<{ packetBytes: number; cacheBytes: number; target: string }> = [];
    const store = createOwnedSessionStore({
      runtimeId: 'codex', surfaceIdPrefix: 'codex-owned:', rootEnvVar: 'CORTEX_IDE_OWNED_CODEX_ROOT',
      rootDefault: path.join(root, 'sessions'), binaryName: 'node', binaryEnvOverride: 'O8_TEST_RUST_WORKER',
      humanLabel: 'Rust cache fixture', squadShortName: 'RustFixture',
      launchArgs: () => ['-e', `require('node:child_process').execFileSync('cargo', ['build', '--offline'], {stdio:'pipe'});require('node:fs').writeFileSync('.o8-cargo-receipt', process.env.CARGO_TARGET_DIR || '');process.stdout.write('done\\n');`],
      resumeArgs: () => null,
      parseRunLog: raw => ({ entries: [], outcome: raw.includes('done') ? 'finished' : 'running', completedTurn: raw.includes('done') }),
    }, { workspaceSpawnGuard: async () => ({ status: 'available', source: 'no-snapshot' }) });
    try {
      for (const number of [1, 2]) {
        const packetId = 'rust-cache-' + number;
        const branch = 'fix/' + packetId;
        const runtimeCwd = vi.spyOn(process, 'cwd').mockReturnValue(runtimeRoot);
        const worktree = await manager.create({ agentType: 'codex', taskName: packetId, branchName: branch,
          baseBranch: 'main', packetId, skipSetup: true, isolationPreference: 'git-worktree' })
          .finally(() => runtimeCwd.mockRestore());
        if (number === 1) {
          const env = { ...process.env }; delete env.CARGO_TARGET_DIR;
          execFileSync('cargo', ['build', '--offline'], { cwd: worktree.path, env, stdio: 'pipe' });
          const identity = await captureWorktreeMaterializationIdentity(worktree.path);
          expect(await rebuildableCargoTargetPaths(worktree.path, identity)).toEqual(['target']);
          const tagPath = path.join(worktree.path, 'target/CACHEDIR.TAG');
          const tag = readFileSync(tagPath);
          rmSync(tagPath);
          expect(await rebuildableCargoTargetPaths(worktree.path, identity)).toEqual([]);
          writeFileSync(tagPath, tag);
          before = disk(path.join(worktree.path, 'target'));
          rmSync(path.join(worktree.path, 'target'), { recursive: true });
        }
        const lane = createLane({ repoPath, worktreePath: worktree.path, branch, baseBranch: 'main', runtime: 'codex', packetId, ownership: 'managed' });
        const launched = await store.launch({ cwd: worktree.path, prompt: 'Build Rust fixture', packetId, laneId: lane.id });
        const deadline = Date.now() + 15_000;
        while (!getLaneEvents(lane.id, 100).some(event => event.verb === 'runtime_process_exit')) {
          if (Date.now() > deadline) throw new Error('Rust worker did not finish.');
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        expect(getLaneEvents(lane.id).find(event => event.verb === 'runtime_process_exit')?.payload.exitCode).toBe(0);
        const target = readFileSync(path.join(worktree.path, '.o8-cargo-receipt'), 'utf8');
        expect(target).toBe(cache);
        expect(existsSync(path.join(worktree.path, 'target'))).toBe(false);
        receipts.push({ packetBytes: 0, cacheBytes: disk(cache), target });
        expect((await store.archiveSession(launched.surfaceId)).archived).toBe(true);
      }
      expect(receipts[1].target).toBe(receipts[0].target);
      expect(before).toBeGreaterThan(0);
      const receiptPath = process.env.O8_RUST_CACHE_DISK_RECEIPT;
      if (receiptPath) {
        mkdirSync(path.dirname(receiptPath), { recursive: true });
        writeFileSync(receiptPath, JSON.stringify({ baselineLocalTargetBytes: before, after: receipts }, null, 2));
      }
      finished = true;
    } finally {
      // Only this fixture repository's unique cache is removed.
      rmSync(cache, { recursive: true, force: true });
    }
  }, 120_000);
});
