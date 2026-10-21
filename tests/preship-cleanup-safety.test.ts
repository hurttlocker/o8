import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { probeMetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';
import { validateGeneratedOutputResource } from '@/lib/workspace/generated-output-validation';
import type { GeneratedOutputResource } from '@/lib/workspace/generated-output-state';

const root = realpathSync(mkdtempSync(path.join(process.env.O8_TEST_FIXTURE_SWEEP_PARENT || os.tmpdir(), 'o8-preship-safety-')));
const script = path.resolve(process.env.O8_PRESHIP_CLEANUP_TEST_SCRIPT || 'scripts/preship-cleanup.mjs');
const children = new Set<ChildProcess>();
let invocation = 0;
afterAll(async ({}, suite) => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGTERM');
      await closed;
    }
  }
  writeFileSync(path.join(root, 'fixture-outcome.json'), JSON.stringify({
    suiteStateAtTeardown: suite.result?.state, root: identity(root), invocations: invocation,
    children: [...children].map(child => ({ pid: child.pid, exitCode: child.exitCode, signal: child.signalCode })),
  }, null, 2));
  console.log(`[preship-safety] retained fixtures: ${root}`);
});

function identity(directory: string) {
  const stat = lstatSync(directory);
  return { canonicalPath: directory, device: stat.dev, inode: stat.ino, volumeId: 'fixture' };
}

function fixture(state?: string) {
  const workspace = mkdtempSync(path.join(root, 'workspace-'));
  const profile = mkdtempSync(path.join(root, 'profile-'));
  const dbPath = path.join(profile, 'fixture.db');
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE workspace_generated_outputs (resource_id TEXT, workspace_path TEXT,
    state TEXT, payload_json TEXT, version INTEGER, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE workspace_retention_holds (hold_id TEXT, workspace_path TEXT, source_device INTEGER,
      source_inode INTEGER, released_at INTEGER);
    CREATE TABLE workspace_exact_claims (operation_id TEXT, expected_path TEXT, source_path TEXT,
      claim_path TEXT, parent_canonical_path TEXT, parent_device INTEGER, parent_inode INTEGER,
      source_device INTEGER, source_inode INTEGER, claim_device INTEGER, claim_inode INTEGER, state TEXT)`);
  const resource = { schema: 'o8/generated-output-resource/v1', resourceId: randomUUID(),
    workspace: identity(workspace), output: null as ReturnType<typeof identity> | null,
    state: state || 'ready', origin: 'managed-creation', version: 1, createdAt: 1, updatedAt: 1,
    revision: { head: 'a'.repeat(40), tree: 'b'.repeat(40), dirty: false, workingDigest: 'c'.repeat(64) },
    owner: { repositoryPath: root, worktreeId: path.basename(workspace) } };
  if (state) {
    mkdirSync(path.join(workspace, '.next'));
    resource.output = identity(path.join(workspace, '.next'));
    writeFileSync(path.join(workspace, '.o8-generated-output-store'),
      createHash('sha256').update(realpathSync(dbPath)).digest('hex'));
  }
  function save(extra = {}) {
    db.prepare('DELETE FROM workspace_generated_outputs').run();
    const payload = { ...resource, ...extra };
    db.prepare('INSERT INTO workspace_generated_outputs VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(payload.resourceId, workspace, payload.state, JSON.stringify(payload), 1, 1, 1);
  }
  if (state) save();
  db.close();
  function update(extra: object) {
    const connection = new Database(dbPath);
    connection.prepare('UPDATE workspace_generated_outputs SET payload_json = ?')
      .run(JSON.stringify({ ...resource, ...extra }));
    connection.close();
  }
  function run(pid?: number) {
    // The red regression must never expose real producers to the old global killer.
    const bin = path.join(profile, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, 'pgrep'), `#!/bin/sh\nprintf '%s\\n' '${pid || ''}'\n`, { mode: 0o700 });
    const result = spawnSync(process.execPath, [script], { cwd: workspace, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        O8_DATA_DIR: profile, CORTEX_IDE_DATA_DIR: profile, CORTEX_IDE_DB_PATH: dbPath } });
    writeFileSync(path.join(root, `command-${++invocation}.json`), JSON.stringify({
      workspace: identity(workspace), command: process.execPath, args: [script],
      pid: result.pid, nativeExit: result.status, signal: result.signal,
      stdout: result.stdout, stderr: result.stderr, error: result.error?.message,
    }, null, 2));
    return result;
  }
  function authority(sql: string, values: Array<string | number | null> = []) {
    const connection = new Database(dbPath);
    connection.prepare(sql).run(...values);
    connection.close();
  }
  return { workspace, profile, dbPath, resource, update, run, authority };
}

async function producer(workspace: string) {
  const next = path.join(workspace, 'node_modules', 'next', 'dist', 'bin', 'next');
  mkdirSync(path.dirname(next), { recursive: true });
  writeFileSync(next, 'process.send("ready"); setInterval(() => {}, 1000);');
  const child = spawn(process.execPath, [next, 'build'],
    { cwd: workspace, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  children.add(child);
  await once(child, 'message');
  return child;
}

describe('preship production CLI preserves producers and locks', () => {
  it('does not mistake a same-workspace orchestrator prompt for a producer', async () => {
    const files = fixture();
    const orchestrator = path.join(files.workspace, 'orchestrator.mjs');
    writeFileSync(orchestrator, 'process.send("ready"); setInterval(() => {}, 1000);');
    const child = spawn(process.execPath, [orchestrator, '--append-system-prompt',
      'Agent instructions: run next build after verification, with the note "next build" retained.'],
      { cwd: files.workspace, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    children.add(child);
    await once(child, 'message');
    const result = files.run(child.pid);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(child.signalCode).toBeNull();
    expect(child.exitCode).toBeNull();
    expect(result.status, result.stderr).toBe(0);
  });

  it('allows an empty workspace and preserves an unrelated matching producer', async () => {
    const files = fixture();
    const unrelated = fixture();
    const child = await producer(unrelated.workspace);
    const result = files.run(child.pid);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(child.signalCode).toBeNull();
    expect(child.exitCode).toBeNull();
    expect(result.status, result.stderr).toBe(0);
  });

  it('refuses a same-workspace producer without signaling it', async () => {
    const files = fixture();
    const child = await producer(files.workspace);
    const result = files.run(child.pid);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(child.signalCode).toBeNull();
    expect(child.exitCode).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('producer');
  });

  it.each(['active', 'failed-held', 'legacy-held', 'planned', 'adopted'])('refuses %s lifecycle output', state => {
    const files = fixture(state);
    expect(files.run().status).toBe(1);
  });

  it('refuses an active PID birth mismatch without signaling the reused PID', async () => {
    const files = fixture('active');
    const unrelated = fixture();
    const child = await producer(unrelated.workspace);
    const birth = await probeMetadataLockProcessIdentity(child.pid!);
    if (birth.state !== 'live') throw new Error('Fixture producer birth is unknown.');
    const attempt = { id: randomUUID(), mode: 'build', ownerPid: child.pid,
      ownerIdentity: { ...birth.identity, startId: `${birth.identity.startId}:wrong-birth` }, children: [] };
    expect(() => validateGeneratedOutputResource({ ...files.resource, attempt } as GeneratedOutputResource)).not.toThrow();
    files.update({ attempt });
    const result = files.run(child.pid);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(child.signalCode).toBeNull();
    expect(child.exitCode).toBeNull();
    expect(result.status).toBe(1);
  });

  it.each(['regular', 'replaced', 'symlink', 'dangling', 'unknown'])('preserves %s lock bytes and inode', kind => {
    const files = fixture(kind === 'unknown' ? undefined : 'ready');
    if (kind === 'unknown') mkdirSync(path.join(files.workspace, '.next'));
    const lock = path.join(files.workspace, '.next', 'lock');
    const target = path.join(files.profile, 'held-lock');
    writeFileSync(target, 'held evidence');
    if (kind === 'symlink' || kind === 'dangling') symlinkSync(kind === 'dangling' ? `${target}-missing` : target, lock);
    else {
      writeFileSync(lock, 'previous lock');
      if (kind === 'replaced') {
        renameSync(lock, `${lock}-previous`);
        writeFileSync(lock, 'replacement lock');
      }
    }
    const before = lstatSync(lock);
    const bytes = kind === 'dangling' ? null : readFileSync(lock);
    expect(files.run().status).toBe(1);
    const after = lstatSync(lock);
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
    if (bytes) expect(readFileSync(lock)).toEqual(bytes);
    expect(readFileSync(target, 'utf8')).toBe('held evidence');
  });

  it('passes quiet owned output and refuses unknown or differently bound output', () => {
    const owned = fixture('ready');
    expect(() => validateGeneratedOutputResource(owned.resource as GeneratedOutputResource)).not.toThrow();
    expect(owned.run().status).toBe(0);
    const unknown = fixture();
    mkdirSync(path.join(unknown.workspace, '.next'));
    expect(unknown.run().status).toBe(1);
    writeFileSync(path.join(owned.workspace, '.o8-generated-output-store'), '0'.repeat(64));
    expect(owned.run().status).toBe(1);
  });

  it('refuses malformed or legacy-origin authority', () => {
    for (const extra of [{ owner: {} }, { origin: 'legacy-observation' }, { revision: {} }, { resourceId: 'invalid' }]) {
      const invalid = fixture('ready');
      invalid.update(extra);
      expect(invalid.run().status).toBe(1);
    }
    expect(fixture('succeeded').run().status).toBe(1);
  });

  it.each(['succeeded', 'ready-start', 'ready-stop', 'succeeded-start-stop', 'succeeded-dev-stop',
    'signaled-build', 'succeeded-mixed-stop'])
    ('checks %s with a native observed producer receipt', async kind => {
    const stop = kind.endsWith('stop') || kind === 'signaled-build';
    const files = fixture(kind.startsWith('succeeded') || kind === 'signaled-build' ? 'succeeded' : 'ready');
    const owner = await probeMetadataLockProcessIdentity(process.pid);
    if (owner.state !== 'live') throw new Error('Fixture parent birth is unknown.');
    const child = spawn(process.execPath, ['-e',
      'process.once("message", () => process.exit(0)); process.send("ready");'],
      { cwd: files.workspace, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    children.add(child);
    await once(child, 'message');
    if (!child.pid) throw new Error('Fixture producer PID is unknown.');
    const birth = await probeMetadataLockProcessIdentity(child.pid);
    if (birth.state !== 'live') throw new Error('Fixture producer birth is unknown.');
    const closed = once(child, 'close');
    if (stop) child.kill('SIGTERM');
    else child.send({ finish: true });
    await closed;
    expect(stop ? child.signalCode : child.exitCode).toBe(stop ? 'SIGTERM' : 0);
    const mode = kind.includes('start') ? 'start'
      : kind.includes('dev') || kind === 'ready-stop' || kind === 'succeeded-mixed-stop' ? 'dev' : 'build';
    const attempt = { id: randomUUID(), mode,
      ownerPid: process.pid, ownerIdentity: owner.identity,
      children: [{ pid: child.pid, identity: birth.identity, observedClosed: true, exitCode: child.exitCode,
        signal: child.signalCode }] };
    if (kind === 'succeeded-mixed-stop') {
      const other = spawn(process.execPath, ['-e',
        'process.once("message", () => process.exit(0)); process.send("ready");'],
        { cwd: files.workspace, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      children.add(other);
      await once(other, 'message');
      if (!other.pid) throw new Error('Fixture producer PID is unknown.');
      const otherBirth = await probeMetadataLockProcessIdentity(other.pid);
      if (otherBirth.state !== 'live') throw new Error('Fixture producer birth is unknown.');
      const otherClosed = once(other, 'close');
      other.kill('SIGINT');
      await otherClosed;
      expect(other.signalCode).toBe('SIGINT');
      attempt.children.push({ pid: other.pid, identity: otherBirth.identity, observedClosed: true,
        exitCode: other.exitCode, signal: other.signalCode });
    }
    const resource = { ...files.resource, attempt } as GeneratedOutputResource;
    expect(() => validateGeneratedOutputResource(resource)).not.toThrow();
    files.update({ attempt });
    expect(files.run().status).toBe(kind === 'signaled-build' || kind === 'succeeded-mixed-stop' ? 1 : 0);
  });

  it.each(['workspace', 'output', 'inode-alias'])('refuses an unreleased %s retention hold without changing persisted state', kind => {
    const files = fixture('ready');
    const held = kind === 'workspace' ? files.resource.workspace : files.resource.output!;
    files.authority('INSERT INTO workspace_retention_holds VALUES (?, ?, ?, ?, NULL)',
      [randomUUID(), kind === 'inode-alias' ? path.join(files.profile, 'alias') : held.canonicalPath, held.device, held.inode]);
    const before = readFileSync(files.dbPath);
    expect(files.run().status).toBe(1);
    expect(readFileSync(files.dbPath)).toEqual(before);
  });

  it('refuses an exact output claim and unknown authority tables, but permits released holds', () => {
    const claimed = fixture('ready');
    claimed.authority('INSERT INTO workspace_exact_claims (operation_id, expected_path, state) VALUES (?, ?, ?)',
      [randomUUID(), claimed.resource.output!.canonicalPath, 'claimed']);
    const before = readFileSync(claimed.dbPath);
    expect(claimed.run().status).toBe(1);
    expect(readFileSync(claimed.dbPath)).toEqual(before);
    const unknown = fixture('ready');
    unknown.authority('DROP TABLE workspace_retention_holds');
    expect(unknown.run().status).toBe(1);
    const released = fixture('ready');
    released.authority('INSERT INTO workspace_retention_holds VALUES (?, ?, ?, ?, ?)',
      [randomUUID(), released.workspace, released.resource.workspace.device, released.resource.workspace.inode, 1]);
    expect(released.run().status).toBe(0);
  });
});


describe('ordinary output creation authority', () => {
  it.each([undefined, { kind: 'unknown', pid: 1, identity: {} },
    { kind: 'prebuild', pid: 0, identity: {} },
    { kind: 'prebuild', pid: 1, identity: { version: 1, platform: 'linux', bootId: '', startId: '' } },
  ])('refuses ownerless output without valid prebuild creation evidence (%j)', creationAuthority => {
    const input = fixture('ready');
    input.update({ owner: undefined, creationAuthority });
    expect(input.run().status).not.toBe(0);
    expect(lstatSync(path.join(input.workspace, '.next')).ino).toBe(input.resource.output!.inode);
  });
});
