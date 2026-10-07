import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const root = mkdtempSync(path.join(os.tmpdir(), 'o8-git-bundle-real-path-'));
const dataDir = path.join(root, 'data');
const token = 'git-bundle-operator-test-token';
mkdirSync(dataDir);
writeFileSync(path.join(dataDir, 'ws-token'), token);
writeFileSync(path.join(dataDir, 'worker-token'), 'git-bundle-worker-test-token');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_WORKTREE_ROOT = path.join(root, 'worktrees');
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = path.join(root, 'sessions');
const fakeCodex = path.join(root, 'fake-codex');
writeFileSync(fakeCodex, '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "codex-cli 0.130.0\\n"; exit 0; fi\nexit 17\n', { mode: 0o700 });
process.env.O8_CODEX_BIN = fakeCodex;

const { GET, POST: restoreArtifacts } = await import('@/app/api/orchestrator/workspace/preservation/route');
const { POST: closePacket } = await import('@/app/api/orchestrator/discard-packet/route');
const { writeOrchestratorControlPlaneState, readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { recordMission } = await import('@/lib/db/missions-store');
const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
const { removeMergedWorktree } = await import('@/lib/orchestrator/worktree-cleanup');
const { closeDb, getSqlite } = await import('@/lib/db');
const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
const { addRepo } = await import('@/lib/repos/registry');
const { WorktreeManager } = await import('@/lib/worktree/manager');
const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
const { getWorkspaceSnapshot, listWorkspaceSnapshotTransitions } = await import('@/lib/worktree/snapshot-state');
const { preserveWorkspaceArtifacts, readWorkspacePreservation } = await import('@/lib/workspace/preservation-store');
const { captureWorkspaceMaterializationSnapshot } = await import('@/lib/workspace/workspace-materialization-retirement');
const { getWorkspaceRetentionHold } = await import('@/lib/workspace/retention-holds');
const artifactWorkers = await import('@/lib/workspace/ignored-artifact-worker');
const execution = await import('@/lib/worktree/materialization-execution');
const repoPath = path.join(root, 'repo');
let repo: Awaited<ReturnType<typeof addRepo>>;
let finished = false;

function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function workspace(packetId: string) {
  finished = false;
  const manager = new WorktreeManager(repo.localPath);
  const created = await manager.create({
    agentType: 'codex', taskName: packetId, packetId, managed: true, skipSetup: true,
    branchName: 'codex/' + packetId, baseBranch: 'main', isolationPreference: 'git-worktree',
  });
  const sessionId = 'codex-owned-' + packetId;
  const sessionDir = path.join(root, 'sessions', sessionId);
  const surfaceId = 'codex-owned:' + sessionId;
  mkdirSync(sessionDir, { recursive: true });
  const session: OwnedSessionRecord = {
    surfaceId, packetId, sessionDir, cwd: created.path, repoPath: created.path, branch: created.branch,
    head: git(created.path, 'rev-parse', 'HEAD'), title: 'Portable preservation regression',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), recentRuns: [],
    latestPrompt: '', latestSummary: 'Idle owned fixture.', threadId: randomUUID(),
    runIdentityLedger: { version: 1, totalRuns: 0, complete: true },
    workspaceBinding: { logicalWorkspaceId: 'packet:' + packetId, repositoryUuid: repo.id, packetId,
      cwd: created.path, version: 1, verifiedAt: new Date().toISOString() },
  };
  writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(session));
  await withWorktreeMetaTransaction(repo.localPath, async (transaction) => {
    const entry = (await transaction.readAll())[created.id]!;
    await transaction.save(created.id, { ...entry, sessionKey: surfaceId });
  });
  const lane = createLane({ repoPath: repo.localPath, worktreePath: created.path, branch: created.branch,
    baseBranch: 'main', runtime: 'codex', packetId, sessionKey: surfaceId, ownership: 'managed' });
  setLaneStatus(lane.id, 'reviewing');
  return { manager, created, lane };
}

function request(packetId: string, format = '') {
  return new NextRequest('http://localhost/api/orchestrator/workspace/preservation?packetId=' + packetId
    + (format ? '&format=' + format : ''), { headers: { authorization: 'Bearer ' + token } });
}

beforeAll(async () => {
  mkdirSync(repoPath);
  git(repoPath, 'init', '-q', '-b', 'main');
  git(repoPath, 'config', 'user.name', 'o8 regression');
  git(repoPath, 'config', 'user.email', 'o8@example.test');
  writeFileSync(path.join(repoPath, '.gitignore'), '.o8/\n.claude/\nnode_modules/\n');
  writeFileSync(path.join(repoPath, 'tracked.txt'), 'base source\n');
  git(repoPath, 'add', '.gitignore', 'tracked.txt');
  git(repoPath, 'commit', '-qm', 'base');
  repo = await addRepo(repoPath);
});

afterAll(() => {
  closeDb();
  if (finished) rmSync(root, { recursive: true, force: true });
});

describe('portable source preservation through the managed retirement entry', () => {
  it('recovers dirty, untracked and unpushed source with its parents in an empty repository', async () => {
    const packetId = 'portable-source';
    const { manager, created } = await workspace(packetId);
    writeFileSync(path.join(created.path, 'unpushed.txt'), 'unpushed commit\n');
    git(created.path, 'add', 'unpushed.txt');
    git(created.path, 'commit', '-qm', 'unpublished work');
    const unpushedHead = git(created.path, 'rev-parse', 'HEAD');
    writeFileSync(path.join(created.path, 'tracked.txt'), 'dirty source at retirement\n');
    writeFileSync(path.join(created.path, 'untracked.txt'), 'untracked source at retirement\n');
    mkdirSync(path.join(created.path, '.o8'), { recursive: true });
    const checkpoint = Buffer.from([0, 255, 42, 128, 0]);
    writeFileSync(path.join(created.path, '.o8', 'checkpoint.bin'), checkpoint);
    expect(await manager.cleanup(created.id)).toBe(true);
    expect(existsSync(created.path)).toBe(false);
    const snapshot = getWorkspaceSnapshot(repo.id, packetId)!;
    expect(snapshot.state).toBe('retired');
    const inspected = await GET(request(packetId));
    expect(inspected.status).toBe(200);
    const summary = (await inspected.json()).result;
    expect(summary.gitBundle).toMatchObject({
      schema: 'o8/workspace-git-bundle/v1', repositoryUuid: repo.id, packetId,
      snapshotGeneration: snapshot.snapshotGeneration, snapshotFingerprint: snapshot.snapshotFingerprint,
      headCommit: snapshot.headCommit, treeSha: snapshot.treeSha, recoveryRef: snapshot.recoveryRef,
      prerequisiteCount: 0, commitCount: 3,
    });
    expect(summary.gitBundle.sha256).toMatch(/^[a-f0-9]{64}$/);
    const downloaded = await GET(request(packetId, 'bundle'));
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get('cache-control')).toContain('no-store');
    const bundle = Buffer.from(await downloaded.arrayBuffer());
    expect(createHash('sha256').update(bundle).digest('hex')).toBe(summary.gitBundle.sha256);
    expect(bundle.length).toBe(summary.gitBundle.bytes);
    const recovery = path.join(root, 'empty-recovery');
    mkdirSync(recovery);
    git(recovery, 'init', '-q', '--template=');
    expect(git(recovery, 'remote')).toBe('');
    expect(existsSync(path.join(recovery, '.git', 'objects', 'info', 'alternates'))).toBe(false);
    const bundlePath = path.join(root, 'source.bundle');
    writeFileSync(bundlePath, bundle, { mode: 0o600 });
    git(recovery, 'bundle', 'verify', bundlePath);
    git(recovery, 'fetch', '--no-tags', bundlePath, snapshot.recoveryRef + ':refs/heads/recovered');
    git(recovery, 'checkout', '-q', 'recovered');
    git(recovery, 'fsck', '--full', '--strict');
    expect(git(recovery, 'rev-parse', 'HEAD')).toBe(snapshot.headCommit);
    expect(git(recovery, 'rev-parse', 'HEAD^{tree}')).toBe(snapshot.treeSha);
    expect(git(recovery, 'rev-list', 'HEAD').split('\n')).toContain(unpushedHead);
    expect(readFileSync(path.join(recovery, 'tracked.txt'), 'utf8')).toBe('dirty source at retirement\n');
    expect(readFileSync(path.join(recovery, 'untracked.txt'), 'utf8')).toBe('untracked source at retirement\n');
    expect(readFileSync(path.join(recovery, 'unpushed.txt'), 'utf8')).toBe('unpushed commit\n');
    const archived = await readWorkspacePreservation(summary.preservationId);
    const entry = archived.payload.capture.entries.find((candidate) => candidate.path === '.o8/checkpoint.bin')!;
    expect(Buffer.from(entry.content!, 'base64')).toEqual(checkpoint);
    const bank = path.join(dataDir, 'workspace-preservation', 'git-bundles');
    expect(readdirSync(bank)).toEqual([summary.gitBundle.sha256 + '.bundle']);
    expect(statSync(bank).mode & 0o077).toBe(0);
    expect(statSync(path.join(bank, summary.gitBundle.sha256 + '.bundle')).mode & 0o077).toBe(0);
    const admission = listWorkspaceSnapshotTransitions(repo.id, packetId).find((entry) => entry.toState === 'retiring');
    expect(admission?.receipt?.gitBundleSha256).toBe(summary.gitBundle.sha256);
    expect(getSqlite().prepare('SELECT count(*) AS count FROM workspace_preservations WHERE packet_id = ?')
      .get(packetId)).toEqual({ count: 1 });
    finished = true;
  }, 60_000);

  it('deduplicates the verified bundle and refuses a tampered bank before removal', async () => {
    const packetId = 'portable-tamper';
    const { manager, created, lane } = await workspace(packetId);
    const identity = { device: statSync(created.path).dev, inode: statSync(created.path).ino };
    const snapshot = (await captureWorkspaceMaterializationSnapshot(repo.localPath, created.path, 'cleanup'))!;
    const first = await preserveWorkspaceArtifacts(snapshot, repo.localPath);
    const second = await preserveWorkspaceArtifacts(snapshot, repo.localPath);
    expect(second).toEqual(first);
    const bank = path.join(dataDir, 'workspace-preservation', 'git-bundles');
    expect(readdirSync(bank).filter((name) => name.startsWith('.prepare-'))).toEqual([]);
    const bundlePath = path.join(bank, first.gitBundle!.sha256 + '.bundle');
    writeFileSync(bundlePath, Buffer.concat([readFileSync(bundlePath), Buffer.from('tampered')]));
    expect(await manager.cleanup(created.id)).toBe(false);
    expect(statSync(created.path)).toMatchObject({ dev: identity.device, ino: identity.inode });
    expect(getWorkspaceSnapshot(repo.id, packetId)?.state).toBe('materialized');
    expect(listWorkspaceSnapshotTransitions(repo.id, packetId).some((entry) => entry.toState === 'retiring')).toBe(false);
    expect(getWorkspaceRetentionHold(created.path, identity)).toMatchObject({
      packetId, laneId: lane.id, sourceDevice: identity.device, sourceInode: identity.inode,
      holdId: 'preservation-failed:' + snapshot.snapshotFingerprint,
    });
    await expect(readWorkspacePreservation(first.preservationId)).rejects.toThrow(/hash or size/);
    expect((await GET(request(packetId, 'bundle'))).status).toBe(409);
    expect(readdirSync(bank).filter((name) => name.startsWith('.prepare-'))).toEqual([]);
    finished = true;
  }, 60_000);

  it('refuses a redirected bank with a scoped hold and leaves outside bytes intact', async () => {
    const packetId = 'portable-redirect';
    const { manager, created, lane } = await workspace(packetId);
    const bank = path.join(dataDir, 'workspace-preservation', 'git-bundles');
    const retainedBank = bank + '-retained';
    const outside = path.join(root, 'outside-bank');
    mkdirSync(outside, { mode: 0o700 });
    writeFileSync(path.join(outside, 'unowned.txt'), 'outside bytes stay intact\n');
    renameSync(bank, retainedBank);
    symlinkSync(outside, bank, 'dir');
    try {
      expect(await manager.cleanup(created.id)).toBe(false);
      expect(existsSync(created.path)).toBe(true);
      expect(readFileSync(path.join(outside, 'unowned.txt'), 'utf8')).toBe('outside bytes stay intact\n');
      expect(readdirSync(outside)).toEqual(['unowned.txt']);
      expect(getWorkspaceSnapshot(repo.id, packetId)?.state).toBe('materialized');
      expect(getWorkspaceRetentionHold(created.path)).toMatchObject({ packetId, laneId: lane.id });
    } finally {
      unlinkSync(bank);
      renameSync(retainedBank, bank);
    }
    finished = true;
  }, 60_000);

  it('refuses incomplete shallow ancestry instead of relying on the source object store', async () => {
    const packetId = 'portable-incomplete';
    const { manager, created, lane } = await workspace(packetId);
    writeFileSync(path.join(created.path, 'incomplete.txt'), 'source with a required parent\n');
    git(created.path, 'add', 'incomplete.txt');
    git(created.path, 'commit', '-qm', 'shallow boundary fixture');
    const boundary = git(created.path, 'rev-parse', 'HEAD');
    writeFileSync(path.join(created.path, 'tracked.txt'), 'new head above boundary\n');
    git(created.path, 'add', 'tracked.txt');
    git(created.path, 'commit', '-qm', 'head above shallow boundary');
    await captureWorkspaceMaterializationSnapshot(repo.localPath, created.path, 'cleanup');
    const shallow = path.join(repo.localPath, '.git', 'shallow');
    writeFileSync(shallow, boundary + '\n', { flag: 'wx' });
    try {
      expect(await manager.cleanup(created.id)).toBe(false);
      expect(readFileSync(path.join(created.path, 'incomplete.txt'), 'utf8')).toBe('source with a required parent\n');
      expect(getWorkspaceSnapshot(repo.id, packetId)?.state).toBe('materialized');
      expect(getWorkspaceRetentionHold(created.path)).toMatchObject({ packetId, laneId: lane.id });
      expect(readdirSync(path.join(dataDir, 'workspace-preservation', 'git-bundles'))
        .filter((name) => name.startsWith('.prepare-'))).toEqual([]);
    } finally {
      unlinkSync(shallow);
    }
    finished = true;
  }, 60_000);

  it('holds the captured owner when its public workspace name is replaced during Git capture', async () => {
    const packetId = 'portable-owner-change';
    const { manager, created, lane } = await workspace(packetId);
    const original = statSync(created.path);
    const retainedPath = created.path + '-retained';
    const proxyDir = path.join(root, 'git-proxy');
    mkdirSync(proxyDir);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const proxy = [
      '#!/usr/bin/env node',
      "const { spawnSync } = require('node:child_process');",
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      'const result = spawnSync(' + JSON.stringify(realGit) + ", args, { stdio: 'inherit' });",
      "if (result.status === 0 && args[4] === 'bundle' && args[5] === 'create') {",
      '  fs.renameSync(' + JSON.stringify(created.path) + ', ' + JSON.stringify(retainedPath) + ');',
      '  fs.mkdirSync(' + JSON.stringify(created.path) + ');',
      '  fs.writeFileSync(' + JSON.stringify(path.join(created.path, 'replacement.txt')) + ", 'unowned replacement');",
      '}',
      'process.exit(result.status ?? 17);',
    ].join('\n');
    writeFileSync(path.join(proxyDir, 'git'), proxy, { mode: 0o700 });
    const priorPath = process.env.PATH;
    process.env.PATH = proxyDir + path.delimiter + priorPath;
    try {
      expect(await manager.cleanup(created.id)).toBe(false);
      expect(statSync(retainedPath)).toMatchObject({ dev: original.dev, ino: original.ino });
      expect(readFileSync(path.join(created.path, 'replacement.txt'), 'utf8')).toBe('unowned replacement');
      expect(readFileSync(path.join(retainedPath, 'tracked.txt'), 'utf8')).toBe('base source\n');
      expect(getWorkspaceSnapshot(repo.id, packetId)?.state).toBe('materialized');
      expect(getWorkspaceRetentionHold(created.path)).toMatchObject({ packetId, laneId: lane.id,
        sourceDevice: original.dev, sourceInode: original.ino });
      expect(listWorkspaceSnapshotTransitions(repo.id, packetId).some((entry) => entry.toState === 'retiring')).toBe(false);
    } finally {
      process.env.PATH = priorPath;
    }
    finished = true;
  }, 60_000);

  it('retains a substituted verifier name without unlinking an outside bundle at publication', async () => {
    const packetId = 'portable-publication-race';
    const { manager, created, lane } = await workspace(packetId);
    const outside = path.join(root, 'publication-outside');
    mkdirSync(outside, { mode: 0o700 });
    const outsideBundle = path.join(outside, 'source.bundle');
    const outsideBytes = Buffer.from('outside source bundle remains at its original name');
    writeFileSync(outsideBundle, outsideBytes, { mode: 0o600 });
    let exercised = false;
    const originalExec = execution.materializationAwareExecFile;
    const spy = vi.spyOn(execution, 'materializationAwareExecFile').mockImplementation((command, args, options) => {
      if (command === process.execPath && args[0] === '-e' && typeof args[2] === 'string'
        && args[1].includes("input.operation === 'publish'")) {
        const input = JSON.parse(args[2]);
        if (input.operation === 'publish') {
          exercised = true;
          // Move the public verifier name after capture, just before the bank child inherits the file descriptor.
          const actor = "    const path = require('node:path');\n"
            + '    const publicName = path.join(input.bankDirectory, input.leaf);\n'
            + "    fs.renameSync(publicName, publicName + '-retained');\n"
            + '    fs.symlinkSync(' + JSON.stringify(outside) + ", publicName, 'dir');\n";
          const modified = args[1].replace('    const result = spawnSync', actor + '    const result = spawnSync');
          expect(modified).not.toBe(args[1]);
          return originalExec(command, ['-e', modified, args[2]], options);
        }
      }
      return originalExec(command, args, options);
    });
    try {
      expect(await manager.cleanup(created.id)).toBe(false);
      expect(exercised).toBe(true);
      expect(readFileSync(outsideBundle)).toEqual(outsideBytes);
      expect(readdirSync(outside)).toEqual(['source.bundle']);
      expect(existsSync(created.path)).toBe(true);
      expect(getWorkspaceSnapshot(repo.id, packetId)?.state).toBe('materialized');
      expect(getWorkspaceRetentionHold(created.path)).toMatchObject({ packetId, laneId: lane.id });
    } finally {
      spy.mockRestore();
    }
    finished = true;
  }, 60_000);

  it('bounds live directory helpers while preserving a broad ignored tree', async () => {
    const packetId = 'artifact-directory-breadth';
    const { manager, created } = await workspace(packetId);
    const targetPacketId = 'artifact-directory-breadth-target';
    const target = await workspace(targetPacketId);
    const checkpoints = Array.from({ length: 12 }, (_, index) => '.o8/recovery-' + index + '/checkpoint.bin');
    const bytes = Buffer.from([0, 255, 42, 128, 0]);
    for (const relative of checkpoints) {
      mkdirSync(path.dirname(path.join(created.path, relative)), { recursive: true });
      writeFileSync(path.join(created.path, relative), bytes);
    }
    const eventsPath = path.join(root, 'artifact-directory-worker-events.jsonl');
    const script = artifactWorkers.artifactNodeScript();
    const marker = 'const workerScript = process.argv[1];';
    const actor = '\nconst workerEvents = ' + JSON.stringify(eventsPath) + ';\n'
      + "fs.appendFileSync(workerEvents, JSON.stringify({ action: 'start', pid: process.pid }) + '\\n');\n"
      + "process.on('exit', () => fs.appendFileSync(workerEvents, JSON.stringify({ action: 'end', pid: process.pid }) + '\\n'));\n";
    const changed = script.replace(marker, marker + actor);
    expect(changed).not.toBe(script);
    const spy = vi.spyOn(artifactWorkers, 'artifactNodeScript').mockReturnValue(changed);
    try {
      expect(await manager.cleanup(created.id)).toBe(true);
      expect(existsSync(created.path)).toBe(false);
      const response = await restoreArtifacts(new NextRequest('http://localhost/api/orchestrator/workspace/preservation', {
        method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ sourcePacketId: packetId, targetPacketId, paths: checkpoints,
          clientMutationId: 'artifact-directory-breadth-restore-once' }),
      }));
      expect(response.status).toBe(200);
      for (const relative of checkpoints) expect(readFileSync(path.join(target.created.path, relative))).toEqual(bytes);
      const live = new Set<number>();
      let peak = 0;
      for (const line of readFileSync(eventsPath, 'utf8').trim().split('\n')) {
        const event = JSON.parse(line) as { action: string; pid: number };
        if (event.action === 'start') { expect(live.has(event.pid)).toBe(false); live.add(event.pid); }
        else { expect(event.action).toBe('end'); expect(live.delete(event.pid)).toBe(true); }
        peak = Math.max(peak, live.size);
      }
      expect(peak).toBe(3);
      expect(live.size).toBe(0);
    } finally { spy.mockRestore(); }
    finished = true;
  }, 60_000);

  it('holds over-deep ignored content before exhausting directory workers', async () => {
    const packetId = 'artifact-directory-depth';
    const { manager, created, lane } = await workspace(packetId);
    const relative = '.o8/' + Array.from({ length: 34 }, () => 'nested').join('/') + '/checkpoint.bin';
    mkdirSync(path.dirname(path.join(created.path, relative)), { recursive: true });
    const bytes = Buffer.from([0, 255, 42, 128, 0]);
    writeFileSync(path.join(created.path, relative), bytes);
    expect(await manager.cleanup(created.id)).toBe(false);
    expect(existsSync(created.path)).toBe(true);
    expect(readFileSync(path.join(created.path, relative))).toEqual(bytes);
    expect(getWorkspaceSnapshot(repo.id, packetId)?.state).toBe('materialized');
    expect(getWorkspaceRetentionHold(created.path)).toMatchObject({ packetId, laneId: lane.id });
    finished = true;
  }, 60_000);

  it('holds a substituted artifact ancestor without reading its outside files', async () => {
    const packetId = 'artifact-parent-substitution';
    const { manager, created, lane } = await workspace(packetId);
    const relative = '.o8/recovery/nested/checkpoint.bin';
    mkdirSync(path.dirname(path.join(created.path, relative)), { recursive: true });
    const originalBytes = Buffer.from([0, 255, 42, 128, 0]);
    writeFileSync(path.join(created.path, relative), originalBytes);
    const outside = path.join(root, 'outside-artifact-capture');
    mkdirSync(outside, { mode: 0o700 });
    const outsideBytes = Buffer.from('outside capture bytes stay intact');
    writeFileSync(path.join(outside, 'sentinel.bin'), outsideBytes);
    const script = artifactWorkers.artifactNodeScript();
    const marker = '    client = await connectArtifactNode(';
    const actor = "    if (part === '.o8') {\n"
      + "      fs.renameSync(part, part + '-retained');\n"
      + '      fs.symlinkSync(' + JSON.stringify(outside) + ", part, 'dir');\n"
      + '    }\n';
    const changed = script.replace(marker, actor + marker);
    expect(changed).not.toBe(script);
    const spy = vi.spyOn(artifactWorkers, 'artifactNodeScript').mockReturnValue(changed);
    try {
      expect(await manager.cleanup(created.id)).toBe(false);
      expect(existsSync(created.path)).toBe(true);
      expect(getWorkspaceSnapshot(repo.id, packetId)?.state).toBe('materialized');
      expect(getWorkspaceRetentionHold(created.path)).toMatchObject({ packetId, laneId: lane.id });
      expect(readFileSync(path.join(created.path, '.o8-retained/recovery/nested/checkpoint.bin'))).toEqual(originalBytes);
      expect(readFileSync(path.join(outside, 'sentinel.bin'))).toEqual(outsideBytes);
      expect(readdirSync(outside)).toEqual(['sentinel.bin']);
    } finally { spy.mockRestore(); }
    finished = true;
  }, 60_000);

  it('refuses a substituted restore ancestor before changing outside bytes', async () => {
    const sourcePacketId = 'artifact-restore-parent-source';
    const source = await workspace(sourcePacketId);
    const targetPacketId = 'artifact-restore-parent-target';
    const target = await workspace(targetPacketId);
    const relative = '.o8/recovery/nested/checkpoint.bin';
    mkdirSync(path.dirname(path.join(source.created.path, relative)), { recursive: true });
    writeFileSync(path.join(source.created.path, relative), Buffer.from([0, 255, 42, 128, 0]));
    expect(await source.manager.cleanup(source.created.id)).toBe(true);
    const outside = path.join(root, 'outside-artifact-restore');
    mkdirSync(outside, { mode: 0o700 });
    const outsideBytes = Buffer.from('outside restore bytes stay intact');
    writeFileSync(path.join(outside, 'sentinel.bin'), outsideBytes);
    const script = artifactWorkers.artifactNodeScript();
    const marker = '    client = await connectArtifactNode(';
    const actor = "    if (part === '.o8') {\n"
      + "      fs.renameSync(part, part + '-retained');\n"
      + '      fs.symlinkSync(' + JSON.stringify(outside) + ", part, 'dir');\n"
      + '    }\n';
    const changed = script.replace(marker, actor + marker);
    expect(changed).not.toBe(script);
    const spy = vi.spyOn(artifactWorkers, 'artifactNodeScript').mockReturnValue(changed);
    try {
      const response = await restoreArtifacts(new NextRequest('http://localhost/api/orchestrator/workspace/preservation', {
        method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ sourcePacketId, targetPacketId, paths: [relative],
          clientMutationId: 'artifact-restore-parent-substitution-once' }),
      }));
      expect(response.status).toBe(409);
      expect(readFileSync(path.join(outside, 'sentinel.bin'))).toEqual(outsideBytes);
      expect(readdirSync(outside)).toEqual(['sentinel.bin']);
      expect(existsSync(path.join(target.created.path, '.o8-retained'))).toBe(true);
      expect(existsSync(path.join(target.created.path, '.o8-retained/recovery/nested/checkpoint.bin'))).toBe(false);
      expect(existsSync(target.created.path)).toBe(true);
      expect(getWorkspaceSnapshot(repo.id, targetPacketId)?.state).not.toBe('retired');
    } finally { spy.mockRestore(); }
    finished = true;
  }, 60_000);

  it('banks dirty source through authenticated Close and restores nested ignored bytes', async () => {
    const packetId = 'close-dirty-source';
    const { created, lane } = await workspace(packetId);
    // Materialize idle targets before reopening the database to verify durable Close state.
    const successor = await workspace('close-dirty-successor');
    const merged = await workspace('merged-dirty-refused');
    writeFileSync(path.join(created.path, 'unpushed.txt'), 'unpublished handoff\n');
    git(created.path, 'add', 'unpushed.txt');
    git(created.path, 'commit', '-qm', 'unpublished handoff');
    const unpublished = git(created.path, 'rev-parse', 'HEAD');
    writeFileSync(path.join(created.path, 'tracked.txt'), 'later dirty decision\n');
    writeFileSync(path.join(created.path, 'untracked.txt'), 'remaining recovery actions\n');
    const checkpointPath = '.o8/recovery/nested/checkpoint.bin';
    const checkpoint = Buffer.from([0, 255, 42, 128, 0, 79, 56, 66, 50, 50, 57, 50, 10]);
    mkdirSync(path.dirname(path.join(created.path, checkpointPath)), { recursive: true });
    writeFileSync(path.join(created.path, checkpointPath), checkpoint);
    setLaneStatus(lane.id, 'paused', 'system', 'operator_stopped');
    const mission = writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(), missionId: 'mission-close-dirty-source',
      repoPath: repo.localPath, runtime: 'codex', updatedAt: new Date().toISOString(),
      packets: [{ id: packetId, referenceLabel: '#3339', title: 'Preserve stopped dirty source',
        summary: 'Verify unmerged Close reaches source and ignored-content preservation.',
        workspaceTargetPath: repo.localPath, branchTarget: created.branch, runtime: 'codex',
        dependencyLabels: [], dependencyPacketIds: [], queueState: 'held', releaseState: 'pending',
        status: 'blocked', operatorStopped: true, review: null, blockedReason: 'Stopped by operator.',
        lane: { tileId: lane.id, tabId: lane.id, repoPath: repo.localPath,
          worktreePath: created.path, runtime: 'codex', laneId: lane.id },
      } as OrchestratorPacket],
    });
    recordMission({ id: mission.missionId!, repoPath: repo.localPath, runtime: 'codex',
      prompt: '', summary: '', constraints: '', totalWaves: 1, missionState: mission,
      packetMeta: mission.packets.map(({ id, title, referenceLabel }) => ({ id, title, referenceLabel })),
    });
    const response = await closePacket(new NextRequest('http://localhost/api/orchestrator/discard-packet', {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ packetId, disposition: 'superseded', clientMutationId: 'close-dirty-source-once' }),
    }));
    const closed = await response.json();
    expect(response.status, JSON.stringify(closed)).toBe(200);
    expect(closed.result).toMatchObject({ closed: true, worktreeRemoved: true });
    expect(existsSync(created.path)).toBe(false);
    closeDb();
    for (const state of [readOrchestratorControlPlaneState(), readMissionRegistryEntry(mission.missionId!, { includeArchived: true })!.mission]) {
      expect(state.packets.find((packet) => packet.id === packetId)).toMatchObject({
        status: 'archived', operatorStopped: true, lane: null,
      });
    }
    const inspected = await GET(request(packetId));
    expect(inspected.status).toBe(200);
    const summary = (await inspected.json()).result;
    const snapshot = getWorkspaceSnapshot(repo.id, packetId)!;
    expect(snapshot.state).toBe('retired');
    const downloaded = await GET(request(packetId, 'bundle'));
    expect(downloaded.status).toBe(200);
    const bundle = Buffer.from(await downloaded.arrayBuffer());
    expect(createHash('sha256').update(bundle).digest('hex')).toBe(summary.gitBundle.sha256);
    const bundlePath = path.join(root, 'closed-dirty.bundle');
    writeFileSync(bundlePath, bundle, { mode: 0o600 });
    const recovery = path.join(root, 'closed-dirty-empty-recovery');
    mkdirSync(recovery);
    git(recovery, 'init', '-q', '--template=');
    expect(git(recovery, 'remote')).toBe('');
    expect(existsSync(path.join(recovery, '.git/objects/info/alternates'))).toBe(false);
    git(recovery, 'bundle', 'verify', bundlePath);
    git(recovery, 'fetch', '--no-tags', bundlePath, snapshot.recoveryRef + ':refs/heads/recovered');
    git(recovery, 'checkout', '-q', 'recovered');
    git(recovery, 'fsck', '--full', '--strict');
    expect(git(recovery, 'rev-list', 'HEAD').split('\n')).toContain(unpublished);
    expect(readFileSync(path.join(recovery, 'tracked.txt'), 'utf8')).toBe('later dirty decision\n');
    expect(readFileSync(path.join(recovery, 'untracked.txt'), 'utf8')).toBe('remaining recovery actions\n');
    expect(readFileSync(path.join(recovery, 'unpushed.txt'), 'utf8')).toBe('unpublished handoff\n');
    const restored = await restoreArtifacts(new NextRequest('http://localhost/api/orchestrator/workspace/preservation', {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ sourcePacketId: packetId, targetPacketId: 'close-dirty-successor',
        paths: [checkpointPath], clientMutationId: 'close-dirty-artifact-restore' }),
    }));
    const restoreReceipt = await restored.json();
    expect(restored.status, JSON.stringify(restoreReceipt)).toBe(200);
    expect(restoreReceipt.result).toMatchObject({ restoredFiles: 1, restoredBytes: checkpoint.length });
    expect(readFileSync(path.join(successor.created.path, checkpointPath))).toEqual(checkpoint);
    writeFileSync(path.join(merged.created.path, 'tracked.txt'), 'post-merge source stays held\n');
    expect(await removeMergedWorktree(merged.lane)).toMatchObject({ removed: false, reason: 'dirty' });
    expect(readFileSync(path.join(merged.created.path, 'tracked.txt'), 'utf8')).toBe('post-merge source stays held\n');
    expect(getWorkspaceSnapshot(repo.id, 'merged-dirty-refused')).toBeNull();
    finished = true;
  }, 60_000);

  it('keeps historical trusted manifests readable and denies private downloads to workers', async () => {
    finished = false;
    const summary = (await (await GET(request('portable-source'))).json()).result;
    const archive = await readWorkspacePreservation(summary.preservationId);
    const historical = { ...archive.payload };
    delete historical.gitBundle;
    const content = Buffer.from(JSON.stringify(historical));
    const legacyId = createHash('sha256').update(content).digest('hex');
    writeFileSync(path.join(dataDir, 'workspace-preservation', legacyId + '.json'), content, { mode: 0o600, flag: 'wx' });
    // Seed a separate historical fixture receipt; never rewrite an existing manifest or owner journal.
    const row = getSqlite().prepare('SELECT * FROM workspace_preservations WHERE preservation_id = ?')
      .get(summary.preservationId) as Record<string, string | number | null>;
    const columns = Object.keys(row);
    getSqlite().prepare('INSERT INTO workspace_preservations (' + columns.join(', ') + ') VALUES ('
      + columns.map(() => '?').join(', ') + ')').run(...columns.map((column) => (
      column === 'preservation_id' || column === 'manifest_sha256' ? legacyId : row[column]
    )));
    closeDb();
    const legacy = await readWorkspacePreservation(legacyId);
    expect(legacy.payload.gitBundle).toBeUndefined();
    expect(legacy.receipt.headCommit).toBe(archive.receipt.headCommit);
    expect(legacy.payload.capture).toEqual(archive.payload.capture);
    const worker = new NextRequest('http://localhost/api/orchestrator/workspace/preservation?packetId=portable-source&format=bundle', {
      headers: { authorization: 'Bearer git-bundle-worker-test-token', host: 'localhost' },
    });
    expect((await GET(worker)).status).toBe(403);
    const anonymous = new NextRequest(worker.url);
    expect((await GET(anonymous)).status).toBe(401);
    finished = true;
  });
});
