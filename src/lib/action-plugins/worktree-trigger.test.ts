import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const registryState = vi.hoisted(() => ({ repos: [] as string[] }));
vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({
    accountingStatus: 'observed' as const,
    probePath: '/',
    availableBytes: 90_000_000_000,
    freeBytes: 90_000_000_000,
    totalBytes: 100_000_000_000,
    error: null,
  })),
}));
vi.mock('@/lib/repos/registry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/repos/registry')>(),
  findRepoByLocalPath: async (localPath: string) => ({ localPath }),
  listReposFresh: async () => registryState.repos.map((localPath) => ({ localPath })),
}));

const roots: string[] = [];
function git(repo: string, args: string[]) {
  execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } });
}
function fixture(delaySeconds = 0, exitCode = 0) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'o8-action-trigger-')));
  roots.push(root);
  const repo = path.join(root, 'repo');
  registryState.repos.push(repo);
  const source = path.join(root, 'source');
  mkdirSync(repo); mkdirSync(source); mkdirSync(path.join(root, 'data'));
  process.env.O8_DATA_DIR = path.join(root, 'data');
  process.env.O8_WORKTREE_ROOT = path.join(root, 'worktrees');
  process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
  git(repo, ['init', '-b', 'main']);
  writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git(repo, ['add', 'README.md']); git(repo, ['commit', '-m', 'seed']);
  const output = path.join(root, 'events.jsonl');
  const script = `#!/bin/sh\n${delaySeconds ? `sleep ${delaySeconds}\n` : ''}cat >> '${output}'\nexit ${exitCode}\n`;
  writeFileSync(path.join(source, 'run.sh'), script); chmodSync(path.join(source, 'run.sh'), 0o700);
  writeFileSync(path.join(source, 'o8-actions.json'), JSON.stringify({
    format: 'o8-actions-v1', id: 'sample', name: 'Sample', version: '1.0.0', description: 'Trigger fixture',
    supportedPlatforms: [process.platform], workspace: 'registered-project',
    files: [{ path: 'run.sh', sha256: createHash('sha256').update(script).digest('hex') }],
    actions: [{ id: 'run', description: 'Capture event', entry: 'run.sh', args: [], timeoutMs: delaySeconds ? 30_000 : 5000 }],
    triggers: [{ id: 'on-create', event: 'worktree.created', actionId: 'run' }],
  }));
  return { root, repo, source, output };
}
afterEach(() => {
  registryState.repos = [];
  delete process.env.O8_DATA_DIR;
  delete process.env.O8_WORKTREE_ROOT;
  delete process.env.O8_SKIP_PRELAUNCH_TYPECHECK;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.resetModules();
});

describe('managed worktree action triggers', () => {
  it('requires a registered project and declared action before review', async () => {
    const { source } = fixture();
    const host = await import('./host');
    const manifest = JSON.parse(readFileSync(path.join(source, 'o8-actions.json'), 'utf8'));
    expect(host.actionManifestSchema.safeParse({ ...manifest, workspace: 'none' }).success).toBe(false);
    expect(host.actionManifestSchema.safeParse({ ...manifest, triggers: [{ id: 'on-create', event: 'worktree.created', actionId: 'missing' }] }).success).toBe(false);
    expect(host.actionManifestSchema.safeParse({ ...manifest, triggers: [manifest.triggers[0], manifest.triggers[0]] }).success).toBe(false);
  });

  it('opts in explicitly, delivers two distinct creations, and does not replay a duplicate or restart', async () => {
    const { repo, source, output } = fixture();
    const host = await import('./host');
    const revision = (await host.reviewActionSource(source, repo)).revision;
    const linked = await host.linkActionSource(source, revision, repo);
    expect(linked.enabledTriggers).toEqual([]);
    expect(() => host.changeActionPluginTrigger('sample', '0'.repeat(64), 'on-create', true)).toThrow();
    expect(host.changeActionPluginTrigger('sample', revision, 'on-create', true).enabledTriggers).toEqual(['on-create']);
    const { WorktreeManager } = await import('@/lib/worktree/manager');
    const manager = new WorktreeManager(repo);
    const first = await manager.create({ agentType: 'codex', taskName: 'first trigger', managed: true, skipSetup: true, baseBranch: 'main', isolationPreference: 'git-worktree' });
    await host.recoverActionPluginTriggers();
    const second = await manager.create({ agentType: 'codex', taskName: 'second trigger', managed: true, skipSetup: true, baseBranch: 'main', isolationPreference: 'git-worktree' });
    await host.recoverActionPluginTriggers();
    const events = readFileSync(output, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ event: 'worktree.created', repositoryPath: repo, worktreeId: first.id, worktreePath: first.path, branch: first.branch, createdAt: new Date(first.createdAt).toISOString() });
    expect(events[1]).toMatchObject({ event: 'worktree.created', worktreeId: second.id });
    expect(events[0].eventId).not.toBe(events[1].eventId);
    expect(host.actionReceipts('sample')).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventId: events[0].eventId, triggerId: 'on-create', status: 'succeeded', actorKind: 'authorization-class', actorIdentity: null }),
      expect.objectContaining({ eventId: events[1].eventId, triggerId: 'on-create', status: 'succeeded' }),
    ]));
    host.publishWorktreeCreated({ repositoryPath: repo, worktreeId: first.id, worktreePath: first.path, branch: first.branch, createdAt: new Date(first.createdAt).toISOString() });
    await host.recoverActionPluginTriggers();
    vi.resetModules();
    await (await import('./host')).recoverActionPluginTriggers();
    expect(readFileSync(output, 'utf8').trim().split('\n')).toHaveLength(2);
  }, 60_000);

  it('records a disabled trigger as skipped and never executes it', async () => {
    const { repo, source, output } = fixture();
    const host = await import('./host');
    const revision = (await host.reviewActionSource(source, repo)).revision;
    await host.linkActionSource(source, revision, repo);
    const { WorktreeManager } = await import('@/lib/worktree/manager');
    const created = await new WorktreeManager(repo).create({ agentType: 'codex', taskName: 'disabled trigger', managed: true, skipSetup: true, baseBranch: 'main', isolationPreference: 'git-worktree' });
    await host.recoverActionPluginTriggers();
    expect(() => readFileSync(output)).toThrow();
    expect(host.actionReceipts('sample')[0]).toMatchObject({ triggerId: 'on-create', status: 'skipped', error: 'Trigger was not enabled when this worktree was created.' });
    expect(created.status).toBe('ready');
    const legacy = await new WorktreeManager(repo).create({ agentType: 'claude-code', taskName: 'metadata only', managed: false });
    expect(legacy.claudeManaged).toBe(true);
    expect(host.actionReceipts('sample')).toHaveLength(1);
  }, 60_000);

  it('keeps a created worktree ready when its action fails and records the failure', async () => {
    const { repo, source, output } = fixture(0, 7);
    const host = await import('./host');
    const revision = (await host.reviewActionSource(source, repo)).revision;
    await host.linkActionSource(source, revision, repo);
    host.changeActionPluginTrigger('sample', revision, 'on-create', true);
    const { WorktreeManager } = await import('@/lib/worktree/manager');
    const created = await new WorktreeManager(repo).create({ agentType: 'codex', taskName: 'failed action', managed: true, skipSetup: true, baseBranch: 'main', isolationPreference: 'git-worktree' });
    await host.recoverActionPluginTriggers();
    const [receipt] = host.actionReceipts('sample');
    expect(created.status).toBe('ready');
    expect(receipt).toMatchObject({ status: 'failed', exit_code: 7, eventId: expect.any(String), triggerId: 'on-create' });
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({ worktreeId: created.id, worktreePath: created.path });
  }, 60_000);

  it('does not run a pre-opt-in event if the trigger is enabled before its delayed delivery', async () => {
    const { repo, source, output, root } = fixture();
    const host = await import('./host');
    const revision = (await host.reviewActionSource(source, repo)).revision;
    await host.linkActionSource(source, revision, repo);
    const { WorktreeManager } = await import('@/lib/worktree/manager');
    const created = await new WorktreeManager(repo).create({ agentType: 'codex', taskName: 'pre consent', managed: true, skipSetup: true, baseBranch: 'main', isolationPreference: 'git-worktree' });
    await host.recoverActionPluginTriggers();
    const oldEvent = host.actionReceipts('sample')[0];
    expect(oldEvent).toMatchObject({ status: 'skipped', triggerId: 'on-create' });
    const database = new Database(path.join(root, 'data', 'customizations', 'actions', 'receipts.sqlite'));
    database.prepare('DELETE FROM receipts WHERE id = ?').run(oldEvent.id);
    database.prepare("UPDATE trigger_deliveries SET status = 'pending', receipt_id = NULL WHERE event_id = ?").run(oldEvent.eventId);
    database.close();
    host.changeActionPluginTrigger('sample', revision, 'on-create', true);
    const lateEventId = host.publishWorktreeCreated({ repositoryPath: repo, worktreeId: `${created.id}-late-journal`, worktreePath: created.path, branch: created.branch, createdAt: new Date(created.createdAt).toISOString() });
    await host.recoverActionPluginTriggers();
    expect(host.actionReceipts('sample')).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventId: oldEvent.eventId, status: 'skipped', error: 'Trigger was not enabled when this worktree was created.' }),
      expect.objectContaining({ eventId: lateEventId, status: 'skipped', error: 'Trigger was not enabled when this worktree was created.' }),
    ]));
    expect(() => readFileSync(output)).toThrow();
  }, 60_000);

  it('drains an event published while another delivery is still running', async () => {
    const { repo, source, output } = fixture(2);
    const host = await import('./host');
    const revision = (await host.reviewActionSource(source, repo)).revision;
    await host.linkActionSource(source, revision, repo);
    host.changeActionPluginTrigger('sample', revision, 'on-create', true);
    const { WorktreeManager } = await import('@/lib/worktree/manager');
    const manager = new WorktreeManager(repo);
    await manager.create({ agentType: 'codex', taskName: 'first ongoing', managed: true, skipSetup: true, baseBranch: 'main', isolationPreference: 'git-worktree' });
    for (let attempt = 0; attempt < 100 && host.actionReceipts('sample')[0]?.status !== 'running'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(host.actionReceipts('sample')[0]?.status).toBe('running');
    await manager.create({ agentType: 'codex', taskName: 'second while running', managed: true, skipSetup: true, baseBranch: 'main', isolationPreference: 'git-worktree' });
    for (let attempt = 0; attempt < 600 && host.actionReceipts('sample').filter((receipt) => receipt.status === 'succeeded').length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(host.actionReceipts('sample').map((receipt) => receipt.status)).toEqual(['succeeded', 'succeeded']);
    expect(readFileSync(output, 'utf8').trim().split('\n')).toHaveLength(2);
  }, 60_000);

  it('retries an enabled event after a different run of the same plugin finishes', async () => {
    const { repo, source, output, root } = fixture();
    const host = await import('./host');
    const revision = (await host.reviewActionSource(source, repo)).revision;
    await host.linkActionSource(source, revision, repo);
    host.changeActionPluginTrigger('sample', revision, 'on-create', true);
    const receiptDb = path.join(root, 'data', 'customizations', 'actions', 'receipts.sqlite');
    const database = new Database(receiptDb);
    database.prepare('INSERT INTO receipts (id, plugin_id, action_id, actor, revision, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('manual-busy', 'sample', 'run', 'local-operator', revision, 'running', new Date().toISOString());
    database.close();
    const { WorktreeManager } = await import('@/lib/worktree/manager');
    await new WorktreeManager(repo).create({ agentType: 'codex', taskName: 'busy then delivered', managed: true, skipSetup: true, baseBranch: 'main', isolationPreference: 'git-worktree' });
    expect(host.actionReceipts('sample').filter((receipt) => receipt.eventId)).toHaveLength(0);
    const finishedDb = new Database(receiptDb);
    finishedDb.prepare("UPDATE receipts SET status = 'succeeded', finished_at = ? WHERE id = 'manual-busy'").run(new Date().toISOString());
    finishedDb.close();
    for (let attempt = 0; attempt < 1_000 && !host.actionReceipts('sample').some((receipt) => receipt.eventId && receipt.status === 'succeeded'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(host.actionReceipts('sample').filter((receipt) => receipt.eventId)).toMatchObject([{ status: 'succeeded', triggerId: 'on-create' }]);
    expect(readFileSync(output, 'utf8').trim().split('\n')).toHaveLength(1);
  }, 60_000);

  it('reconstructs a lost journal event from the durable ready marker after restart', async () => {
    const { repo, source, output, root } = fixture();
    const host = await import('./host');
    const revision = (await host.reviewActionSource(source, repo)).revision;
    await host.linkActionSource(source, revision, repo);
    host.changeActionPluginTrigger('sample', revision, 'on-create', true);
    const receiptDb = path.join(root, 'data', 'customizations', 'actions', 'receipts.sqlite');
    const savedDb = `${receiptDb}.temporarily-unavailable`;
    renameSync(receiptDb, savedDb);
    symlinkSync(savedDb, receiptDb);
    const { WorktreeManager } = await import('@/lib/worktree/manager');
    const created = await new WorktreeManager(repo).create({ agentType: 'codex', taskName: 'recover journal', managed: true, skipSetup: true, baseBranch: 'main', isolationPreference: 'git-worktree' });
    const { readWorktreeMetaSnapshot } = await import('@/lib/worktree/metadata-store');
    expect((await readWorktreeMetaSnapshot(repo))[created.id]).toMatchObject({ status: 'ready', actionTriggerEventPending: true, materializationIdentity: expect.any(Object) });
    expect(() => readFileSync(output)).toThrow();
    rmSync(receiptDb);
    renameSync(savedDb, receiptDb);
    vi.resetModules();
    const restarted = await import('./host');
    await restarted.reconcileWorktreeCreatedEvents();
    await restarted.recoverActionPluginTriggers();
    expect(restarted.actionReceipts('sample')).toMatchObject([{ status: 'succeeded', eventId: expect.any(String), triggerId: 'on-create' }]);
    expect((await readWorktreeMetaSnapshot(repo))[created.id].actionTriggerEventPending).toBe(false);
    expect(readFileSync(output, 'utf8').trim().split('\n')).toHaveLength(1);
  }, 60_000);

  it('does not retry a claimed delivery after process recovery', async () => {
    const { repo, source, output, root } = fixture();
    const host = await import('./host');
    const revision = (await host.reviewActionSource(source, repo)).revision;
    await host.linkActionSource(source, revision, repo);
    const eventId = 'a'.repeat(64);
    const database = new Database(path.join(root, 'data', 'customizations', 'actions', 'receipts.sqlite'));
    database.prepare('INSERT INTO trigger_events VALUES (?, ?, ?)').run(eventId, JSON.stringify({ eventId, event: 'worktree.created', repositoryPath: repo, worktreeId: 'already-claimed', worktreePath: path.join(root, 'worktrees', 'already-claimed'), branch: 'test/already-claimed', createdAt: new Date().toISOString() }), new Date().toISOString());
    database.prepare('INSERT INTO trigger_deliveries (event_id, plugin_id, trigger_id, action_id, revision, status, receipt_id, eligible_at_publish) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(eventId, 'sample', 'on-create', 'run', revision, 'claimed', 'receipt-claimed', 1);
    database.prepare('INSERT INTO receipts (id, plugin_id, action_id, actor, revision, status, started_at, event_id, trigger_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('receipt-claimed', 'sample', 'run', 'event-trigger', revision, 'running', new Date(Date.now() - 61_000).toISOString(), eventId, 'on-create');
    database.close();
    vi.resetModules();
    const restarted = await import('./host');
    await restarted.recoverActionPluginTriggers();
    expect(restarted.actionReceipts('sample')[0]).toMatchObject({ eventId, status: 'interrupted', actorKind: 'authorization-class', actorIdentity: null });
    expect(() => readFileSync(output)).toThrow();
  });
});
