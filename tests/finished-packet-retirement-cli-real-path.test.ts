import { execFileSync, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
const syscall = vi.hoisted(() => ({ preload: '' }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    if (syscall.preload && args[0] === process.execPath && Array.isArray(args[1])
      && args[1][0] === '-e' && args[1][1]?.includes('O8_PURGE_CAPTURED')) {
      return actual.spawn(args[0], ['--require', syscall.preload, ...args[1]], args[2]);
    }
    return Reflect.apply(actual.spawn, undefined, args);
  } };
});
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
const { createLane, getLane, getLaneEvents, setLaneStatus } = await import('@/lib/lane/registry');
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

async function ownedWorkspace(repo: Awaited<ReturnType<typeof addRepo>>, packetId: string, revision: string, provisionEnvironment = false) {
  const worktreeId = 'packet-' + packetId;
  const branch = 'codex/' + packetId;
  const workspacePath = path.join(resolveWorktreeRootLayout(repo.localPath).primaryBase, worktreeId);
  if (provisionEnvironment) {
    await new WorktreeManager(repo.localPath).create({
      agentType: 'codex', taskName: packetId, packetId, branchName: branch,
      baseBranch: revision, managed: true, skipSetup: true, envMode: 'skip',
      isolationPreference: 'git-worktree',
      envFiles: packetId.endsWith('leading-dot') ? ['./.env', './.env.local'] : undefined,
    });
  } else {
    mkdirSync(path.dirname(workspacePath), { recursive: true });
    git(repo.localPath, 'clone', '--quiet', '--no-hardlinks', '--no-checkout', repo.localPath, workspacePath);
    git(workspacePath, 'checkout', '-qb', branch, revision);
  }
  // Pre-fix packets can still carry reference receipts. Preserve retirement
  // coverage without asking current provisioning to create unsafe bindings.
  if (provisionEnvironment) {
    const environmentReferences = Object.fromEntries(['.env', '.env.local'].map((name) => {
      const source = path.join(repo.localPath, name);
      symlinkSync(source, path.join(workspacePath, name));
      return [name, source];
    }));
    await withWorktreeMetaTransaction(repo.localPath, async (transaction) => {
      const entry = (await transaction.readAll())[worktreeId]!;
      await transaction.save(worktreeId, { ...entry, environmentReferences });
    });
  }
  git(workspacePath, 'config', 'user.name', 'o8 regression');
  git(workspacePath, 'config', 'user.email', 'o8@example.test');
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
  await withWorktreeMetaTransaction(repo.localPath, async (transaction) => transaction.save(worktreeId, {
    ...(await transaction.readAll())[worktreeId],
    id: worktreeId, agentType: 'codex', sessionKey: surfaceId, baseBranch: 'main', createdAt: Date.now(),
    claudeManaged: false, taskName: packetId, branchName: branch, status: 'ready', isolationKind: provisionEnvironment ? 'git-worktree' : 'apfs-cow-clone',
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
  writeFileSync(path.join(repoPath, '.gitignore'), '.o8/\nnode_modules/\n.env*\n');
  writeFileSync(path.join(repoPath, 'tracked.txt'), 'base source\n');
  mkdirSync(path.join(repoPath, 'checked', 'nested'), { recursive: true });
  writeFileSync(path.join(repoPath, 'checked', 'nested', 'evidence.txt'), 'outside bytes must survive\n');
  git(repoPath, 'add', '.gitignore', 'tracked.txt', 'checked');
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


async function finishedPacket(packetId: string, status: 'archived' | 'completed' | 'failed' | 'reviewing' | 'paused' = 'archived',
  retainedSession?: 'ordinary' | 'read-only', provisionEnvironment = false) {
  const repo = await addRepo(repoPath);
  const source = await ownedWorkspace(repo, packetId, 'main', provisionEnvironment);
  if (retainedSession !== 'read-only') {
    writeFileSync(path.join(source.workspacePath, 'tracked.txt'), 'completed source\n');
    git(source.workspacePath, 'commit', '-qam', 'completed source');
  }
  const head = git(source.workspacePath, 'rev-parse', 'HEAD');
  setLaneStatus(source.lane.id, status);
  const sessionDir = path.join(root, 'sessions', 'codex-owned-' + packetId);
  if (retainedSession) {
    const recordPath = path.join(sessionDir, 'session.json');
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as OwnedSessionRecord;
    record.laneId = source.lane.id;
    if (retainedSession === 'read-only') {
      record.model = 'gpt-6.1-sol';
      record.effort = 'medium';
      record.runtimeConfig = { workMode: 'read-only' };
      record.executionPolicy = { version: 1, mode: 'single-attempt', runtime: 'codex',
        model: record.model, effort: record.effort, runtimeConfig: record.runtimeConfig };
    }
    writeFileSync(recordPath, JSON.stringify(record));
  } else rmSync(sessionDir, { recursive: true });
  const { resetOwnedSessionIndex } = await import('@/lib/runtimes/shared/owned-session-index');
  resetOwnedSessionIndex();
  if (retainedSession) {
    await import('@/lib/runtimes');
    const { getOwnedSessionLifecycle } = await import('@/lib/runtimes/shared/owned-session-lifecycle');
    const archived = await getOwnedSessionLifecycle(source.lane.sessionKey!)!.archiveSession(source.lane.sessionKey!);
    expect(archived?.archived, archived?.note).toBe(true);
  }
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

async function archive(laneId: string) {
  return fetch('http://127.0.0.1:' + port + '/api/lanes', {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ verb: 'archive', laneId }),
  });
}

describe('finished packet checkout retirement', () => {
  it.each(['skip', 'symlink'] as const)('keeps %s bootstrap explicit and never blesses an existing destination', async (envMode) => {
    const manager = new WorktreeManager(repoPath);
    const created = await manager.create({
      agentType: 'codex', taskName: 'existing-env-' + envMode, packetId: 'existing-env-' + envMode,
      baseBranch: 'main', managed: true, skipSetup: true, envMode, envFiles: ['tracked.txt'],
      isolationPreference: 'git-worktree',
    });
    expect(lstatSync(path.join(created.path, 'tracked.txt')).isSymbolicLink()).toBe(false);
    const metadata = await withWorktreeMetaTransaction(repoPath, async (transaction) => (await transaction.readAll())[created.id]);
    expect(metadata?.environmentReferences).toBeUndefined();
    expect(readFileSync(path.join(created.path, 'tracked.txt'), 'utf8')).toBe('base source\n');
    expect(await manager.cleanup(created.id, { force: true, deleteBranch: true })).toBe(true);
  }, 120_000);

  it('retires an explicit standalone environment reference without touching its source', async () => {
    const name = '.env.standalone';
    const source = path.join(repoPath, name);
    writeFileSync(source, 'O8_ENV_FIXTURE=standalone\n');
    const sourceStat = lstatSync(source);
    try {
      const manager = new WorktreeManager(repoPath);
      const created = await manager.create({
        agentType: 'codex', taskName: 'standalone-env-reference', baseBranch: 'main',
        managed: true, skipSetup: true, envMode: 'symlink', envFiles: [name],
        isolationPreference: 'git-worktree',
      });
      expect(lstatSync(path.join(created.path, name)).isSymbolicLink()).toBe(true);
      expect(await manager.cleanup(created.id, { force: true, deleteBranch: true })).toBe(true);
      expect(existsSync(created.path)).toBe(false);
      expect(lstatSync(source).ino).toBe(sourceStat.ino);
      expect(readFileSync(source, 'utf8')).toBe('O8_ENV_FIXTURE=standalone\n');
    } finally { rmSync(source, { force: true }); }
  }, 120_000);

  it.each(['original', 'leading-dot', 'source-removed', 'source-rotated', 'file-replacement', 'link-replacement'] as const)(
    'retires legacy packet environment references and safely handles %s on close', async (change) => {
      const values = { '.env': 'O8_ENV_FIXTURE=base\n', '.env.local': 'O8_ENV_FIXTURE=local\n' };
      for (const [name, value] of Object.entries(values)) writeFileSync(path.join(repoPath, name), value);
      const sourceStats = Object.fromEntries(Object.keys(values).map((name) => [name, lstatSync(path.join(repoPath, name))]));
      try {
        const packetId = 'finished-env-reference-' + change;
        const { repo, source } = await finishedPacket(packetId, 'completed', undefined, true);
        for (const name of Object.keys(values)) {
          expect(lstatSync(path.join(source.workspacePath, name)).isSymbolicLink()).toBe(true);
        }
        // A development task resolves the configuration at its ordinary checkout path.
        expect(execFileSync(process.execPath, ['--env-file=.env.local', '-e',
          'process.stdout.write(process.env.O8_ENV_FIXTURE)'], {
          cwd: source.workspacePath, encoding: 'utf8',
        })).toBe('local');
        if (change === 'source-removed') rmSync(path.join(repoPath, '.env.local'));
        if (change === 'source-rotated') {
          writeFileSync(path.join(repoPath, '.env.rotated'), values['.env.local']);
          rmSync(path.join(repoPath, '.env.local'));
          symlinkSync('.env.rotated', path.join(repoPath, '.env.local'));
          sourceStats['.env.local'] = lstatSync(path.join(repoPath, '.env.local'));
        }
        if (change.endsWith('replacement')) {
          rmSync(path.join(source.workspacePath, '.env.local'));
          if (change === 'file-replacement') writeFileSync(path.join(source.workspacePath, '.env.local'), values['.env.local']);
          else symlinkSync(path.join(repoPath, '.env'), path.join(source.workspacePath, '.env.local'));
        }
        const closed = await cli(['packet', 'close', packetId, '--reason', 'superseded']);
        if (!change.endsWith('replacement')) {
          expect(closed.exitCode, closed.stderr + closed.stdout).toBe(0);
          expect(existsSync(source.workspacePath)).toBe(false);
          const snapshot = getWorkspaceSnapshot(repo.id, packetId);
          expect(snapshot?.state).toBe('retired');
          const { preservationIdForSnapshot, readWorkspacePreservation } = await import('@/lib/workspace/preservation-store');
          const { payload } = await readWorkspacePreservation(preservationIdForSnapshot(snapshot!)!);
          expect(payload.capture.entries.some((entry) => entry.path.startsWith('.env'))).toBe(false);
          expect(JSON.stringify(payload)).not.toContain('O8_ENV_FIXTURE');
        } else {
          expect(closed.exitCode).not.toBe(0);
          expect(closed.stderr + closed.stdout).toContain('close_failed');
          expect(existsSync(source.workspacePath)).toBe(true);
          expect(getWorkspaceSnapshot(repo.id, packetId)?.state).not.toBe('retired');
        }
        for (const [name, value] of Object.entries(values)) {
          if (change === 'source-removed' && name === '.env.local') continue;
          expect(readFileSync(path.join(repoPath, name), 'utf8')).toBe(value);
          expect(lstatSync(path.join(repoPath, name)).ino).toBe(sourceStats[name]!.ino);
        }
      } finally {
        for (const name of [...Object.keys(values), '.env.rotated']) rmSync(path.join(repoPath, name), { force: true });
      }
    }, 120_000,
  );

  it.each(['file-open', 'final-stat'] as const)('archive refuses an intermediate symlink swap at the native %s seam without changing outside bytes', async (swapAt) => {
    const packetId = 'finished-component-race-' + swapAt;
    const { repo, source } = await finishedPacket(packetId, 'completed');
    const armed = path.join(root, swapAt + '-race-armed');
    const swapped = path.join(root, swapAt + '-race-swapped');
    const outside = path.join(root, swapAt + '-escaped-component');
    const preload = path.join(root, swapAt + '-purge-syscall-seam.cjs');
    writeFileSync(preload, `
      const fs = require('node:fs');
      const fsp = require('node:fs/promises');
      const path = require('node:path');
      const open = fsp.open;
      let evidenceFd;
      let stats = 0;
      function swap() {
        if (fs.existsSync(${JSON.stringify(armed)}) && !fs.existsSync(${JSON.stringify(swapped)})) {
          const candidate = fs.realpathSync('.');
          const checked = candidate.includes('/checked/') ? candidate.slice(0, candidate.indexOf('/checked/') + 8) : path.join(candidate, 'checked');
          fs.renameSync(checked, ${JSON.stringify(outside)});
          fs.symlinkSync(${JSON.stringify(outside)}, checked, 'dir');
          fs.writeFileSync(${JSON.stringify(swapped)}, 'swapped');
        }
      }
      fsp.open = async function(name, ...args) {
        if (path.basename(String(name)) === 'evidence.txt' && ${JSON.stringify(swapAt)} === 'file-open') swap();
        const handle = await open.call(this, name, ...args);
        if (path.basename(String(name)) === 'evidence.txt') evidenceFd = handle.fd;
        return handle;
      };
      const fstat = fs.fstatSync;
      fs.fstatSync = function(fd, ...args) {
        const result = fstat.call(this, fd, ...args);
        if (fd === evidenceFd && ++stats === 2 && ${JSON.stringify(swapAt)} === 'final-stat') swap();
        return result;
      };
    `);
    const purgeModule = await import('@/lib/workspace/exact-directory-purge');
    const purge = purgeModule.purgeExactDirectory;
    const seam = vi.spyOn(purgeModule, 'purgeExactDirectory').mockImplementation((candidate, identity, before, after, ...rest) =>
      purge(candidate, identity, before, async (captured, witness) => {
        await after?.(captured, witness);
        writeFileSync(armed, 'armed');
      }, ...rest));
    syscall.preload = preload;
    try {
      const response = await archive(source.lane.id);
      expect(response.status, await response.text()).toBe(200);
      expect(existsSync(swapped)).toBe(true);
      expect(readFileSync(path.join(outside, 'nested', 'evidence.txt'), 'utf8')).toBe('outside bytes must survive\n');
      expect(getWorkspaceSnapshot(repo.id, packetId)?.state).not.toBe('retired');
    } finally { syscall.preload = ''; seam.mockRestore(); }
  }, 120_000);

  it('archive retains a same-inode write after the native manifest and final authorization', async () => {
    const { repo, source } = await finishedPacket('finished-late-inode-write', 'completed');
    const purgeModule = await import('@/lib/workspace/exact-directory-purge');
    const purge = purgeModule.purgeExactDirectory;
    let retained = '';
    const seam = vi.spyOn(purgeModule, 'purgeExactDirectory').mockImplementation((candidate, identity, before, after, ...rest) =>
      purge(candidate, identity, before, async (captured, witness) => {
        await after?.(captured, witness);
        retained = path.join(captured, 'tracked.txt');
        writeFileSync(retained, 'late source must survive\n');
      }, ...rest));
    try {
      const response = await archive(source.lane.id);
      expect(response.status, await response.text()).toBe(200);
      expect(existsSync(retained)).toBe(true);
      expect(readFileSync(retained, 'utf8')).toBe('late source must survive\n');
      expect(getWorkspaceSnapshot(repo.id, 'finished-late-inode-write')?.state).not.toBe('retired');
    } finally { seam.mockRestore(); }
  }, 120_000);

  it.each(['paused', 'reviewing'] as const)('archive does not retire a %s checkout before terminalization', async (status) => {
    const { repo, source, head } = await finishedPacket('finished-nonterminal-' + status, status, 'ordinary');
    const response = await archive(source.lane.id);
    expect(response.status, await response.text()).toBe(200);
    expect(existsSync(source.workspacePath)).toBe(true);
    expect(git(source.workspacePath, 'rev-parse', 'HEAD')).toBe(head);
    expect(getWorkspaceSnapshot(repo.id, 'finished-nonterminal-' + status)?.state).not.toBe('retired');
  }, 120_000);

  it('archive rechecks persisted terminal status after owner admission under the lifecycle lease', async () => {
    const packetId = 'finished-terminal-recheck';
    const { repo, source } = await finishedPacket(packetId, 'completed', 'ordinary');
    const owners = await import('@/lib/orchestrator/close-orphaned-owner');
    const prepare = owners.prepareOrphanCloseOwners;
    const { getSqlite } = await import('@/lib/db');
    const seam = vi.spyOn(owners, 'prepareOrphanCloseOwners').mockImplementation(async (targets) => {
      const result = await prepare(targets);
      expect(getSqlite().prepare('SELECT owner_pid FROM workspace_lifecycle_leases WHERE packet_id = ?').get(packetId))
        .toMatchObject({ owner_pid: process.pid });
      // Simulate a stale writer bypassing the normal terminal-transition guard.
      getSqlite().prepare("UPDATE lanes SET status = 'reviewing' WHERE id = ?").run(source.lane.id);
      return result;
    });
    try {
      const response = await archive(source.lane.id);
      expect(response.status, await response.text()).toBe(200);
      expect(seam).toHaveBeenCalledOnce();
      expect(existsSync(source.workspacePath)).toBe(true);
      expect(getWorkspaceSnapshot(repo.id, packetId)?.state).not.toBe('retired');
    } finally { seam.mockRestore(); }
  }, 120_000);

  it.each(['archive', 'close'] as const)('%s retires an archived read-only reviewer with a clean base head', async (entry) => {
    const packetId = 'finished-read-only-' + entry;
    const { repo, source, head } = await finishedPacket(packetId, 'archived', 'read-only');
    expect(git(source.workspacePath, 'status', '--porcelain')).toBe('');
    expect(git(repoPath, 'rev-parse', 'main')).toBe(head);
    if (entry === 'archive') {
      const response = await archive(source.lane.id);
      expect(response.status, await response.text()).toBe(200);
    } else {
      const result = await cli(['packet', 'close', packetId, '--reason', 'superseded']);
      expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    }
    expect(existsSync(source.workspacePath)).toBe(false);
    expect(getWorkspaceSnapshot(repo.id, packetId)).toMatchObject({ state: 'retired', headCommit: head });
    expect(existsSync(spawnReceipt)).toBe(false);
  }, 120_000);

  it.each(['dirty', 'unmerged'] as const)('archive keeps a read-only checkout with %s source', async (condition) => {
    const packetId = 'finished-read-only-' + condition;
    const { repo, source } = await finishedPacket(packetId, 'archived', 'read-only');
    writeFileSync(path.join(source.workspacePath, 'tracked.txt'), 'unpreserved reviewer source\n');
    if (condition === 'unmerged') git(source.workspacePath, 'commit', '-qam', 'unmerged reviewer source');
    const response = await archive(source.lane.id);
    expect(response.status, await response.text()).toBe(200);
    expect(existsSync(source.workspacePath)).toBe(true);
    expect(readFileSync(path.join(source.workspacePath, 'tracked.txt'), 'utf8')).toBe('unpreserved reviewer source\n');
    expect(getWorkspaceSnapshot(repo.id, packetId)?.state).not.toBe('retired');
  }, 120_000);

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

  it.each([false, true])('closes an externally merged archived packet with artifact helpers and outside holder=%s', async (outsideHolder) => {
    const packetId = 'finished-merged-holder-' + outsideHolder;
    const { repo, source, head } = await finishedPacket(packetId);
    // The remote adopts the packet's commit before Close, as with a PR merged
    // outside the app. Ignored unique content requires preservation readers.
    const remote = path.join(root, 'merged-remote-' + outsideHolder + '.git');
    git(repoPath, 'clone', '--bare', '--quiet', repoPath, remote);
    const ignorePath = path.join(source.workspacePath, '.gitignore');
    writeFileSync(ignorePath, readFileSync(ignorePath, 'utf8') + 'review-notes/\n');
    git(source.workspacePath, 'commit', '-qam', 'ignore review artifacts');
    const preservedHead = git(source.workspacePath, 'rev-parse', 'HEAD');
    git(source.workspacePath, 'push', '--quiet', remote, 'HEAD:refs/heads/main');
    mkdirSync(path.join(source.workspacePath, 'review-notes'));
    writeFileSync(path.join(source.workspacePath, 'review-notes', 'result.txt'), 'retained review evidence\n');
    const holder = outsideHolder ? spawn(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(() => {}, 1000)'], {
      cwd: source.workspacePath, stdio: ['ignore', 'pipe', 'pipe'],
    }) : null;
    if (holder) await new Promise(resolve => holder.stdout!.once('data', resolve));
    try {
      const closed = await cli(['packet', 'close', packetId, '--reason', 'adopted_elsewhere']);
      if (holder) {
        expect(closed.exitCode).not.toBe(0);
        expect(existsSync(source.workspacePath)).toBe(true);
        expect(closed.stderr + closed.stdout).toContain(`PID ${holder.pid} (node)`);
        expect(getLaneEvents(source.lane.id).some(event => event.payload.phase === 'archive_cleanup_held'
          && String(event.payload.detail).includes(`PID ${holder.pid} (node)`))).toBe(true);
        expect(readFileSync(path.join(source.workspacePath, 'review-notes', 'result.txt'), 'utf8')).toBe('retained review evidence\n');
      } else {
        expect(closed.exitCode, closed.stderr + closed.stdout).toBe(0);
        expect(existsSync(source.workspacePath)).toBe(false);
        const snapshot = getWorkspaceSnapshot(repo.id, packetId)!;
        expect(snapshot).toMatchObject({ state: 'retired', headCommit: preservedHead });
        expect(git(repoPath, 'rev-parse', snapshot.recoveryRef)).toBe(preservedHead);
        const { getWorkspaceRetirementPreservationId } = await import('@/lib/workspace/workspace-materialization-retirement');
        const { readWorkspacePreservation } = await import('@/lib/workspace/preservation-store');
        const preservation = await readWorkspacePreservation(getWorkspaceRetirementPreservationId(source.workspacePath)!);
        expect(preservation.payload.capture.entries).toContainEqual(expect.objectContaining({
          path: 'review-notes/result.txt', content: Buffer.from('retained review evidence\n').toString('base64'),
        }));
        expect(getLaneEvents(source.lane.id).some(event => event.verb === 'close_timing'
          && Number(event.payload.artifactHelperStarts) > 0)).toBe(true);
      }
      expect(git(remote, 'rev-parse', 'main')).toBe(preservedHead);
      expect(git(remote, 'merge-base', '--is-ancestor', head, 'main')).toBe('');
    } finally {
      if (holder) {
        const closed = new Promise(resolve => holder.once('close', resolve));
        holder.kill(); await closed;
      }
    }
    if (holder) {
      const retried = await cli(['packet', 'close', packetId, '--reason', 'adopted_elsewhere']);
      expect(retried.exitCode, retried.stderr + retried.stdout).toBe(0);
      expect(existsSync(source.workspacePath)).toBe(false);
      expect(getWorkspaceSnapshot(repo.id, packetId)).toMatchObject({ state: 'retired', headCommit: preservedHead });
    }
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
