import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { probeMetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';
import { withWorktreeMetaTransaction } from '@/lib/worktree/metadata-store';
import { resolveWorktreeRootLayout } from '@/lib/worktree/root-layout';

const childScript = String.raw`
void (async () => {
  const imported = await import('./src/lib/worktree/metadata-store.ts');
  const { withWorktreeMetaTransaction } = imported.default ?? imported;
  process.stdout.write('O8_METADATA_ATTEMPT\n');
  await withWorktreeMetaTransaction(process.env.O8_METADATA_REPO, async () => {
    process.stdout.write('O8_METADATA_ENTERED\n');
    if (process.env.O8_METADATA_HOLD === '1') {
      await new Promise((resolve) => {
        process.stdin.once('data', resolve);
        process.stdin.resume();
      });
    }
  });
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;

class ChildOutput {
  stdout = '';
  stderr = '';

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (chunk: Buffer) => { this.stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { this.stderr += chunk.toString(); });
  }

  async waitFor(marker: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.stdout.includes(marker)) {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        throw new Error(`Metadata child exited before ${marker}: ${this.stdout}${this.stderr}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out before ${marker}: ${this.stdout}${this.stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  waitForExit(): Promise<number | null> {
    if (this.child.exitCode !== null) return Promise.resolve(this.child.exitCode);
    if (this.child.signalCode !== null) return Promise.resolve(null);
    return new Promise((resolve) => this.child.once('exit', resolve));
  }
}

const roots: string[] = [];
const children: ChildOutput[] = [];
const priorDataDir = process.env.CORTEX_IDE_DATA_DIR;
const priorO8DataDir = process.env.O8_DATA_DIR;
const priorDbPath = process.env.CORTEX_IDE_DB_PATH;
const priorWorktreeRoot = process.env.O8_WORKTREE_ROOT;

function fixture(label: string) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), `o8-metadata-lease-${label}-`));
  roots.push(dataDir);
  const repoPath = path.join(dataDir, 'repo');
  const worktreeRoot = path.join(dataDir, 'worktrees');
  const databasePath = path.join(dataDir, 'cortex-ide.db');
  mkdirSync(repoPath);
  process.env.CORTEX_IDE_DATA_DIR = dataDir;
  process.env.O8_DATA_DIR = dataDir;
  process.env.CORTEX_IDE_DB_PATH = databasePath;
  process.env.O8_WORKTREE_ROOT = worktreeRoot;
  const metadataRoot = resolveWorktreeRootLayout(repoPath).primaryBase;
  const lockPath = path.join(metadataRoot, '.meta.json.lock');
  return { dataDir, databasePath, lockPath, metadataRoot, repoPath, worktreeRoot };
}

function launch(
  fixtureValue: ReturnType<typeof fixture>,
  hold: boolean,
): ChildOutput {
  const inheritedNodeOptions = process.env.NODE_OPTIONS?.trim();
  const child = spawn(path.join(process.cwd(), 'node_modules/.bin/tsx'), ['--eval', childScript], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CORTEX_IDE_DATA_DIR: fixtureValue.dataDir,
      O8_DATA_DIR: fixtureValue.dataDir,
      CORTEX_IDE_DB_PATH: fixtureValue.databasePath,
      O8_WORKTREE_ROOT: fixtureValue.worktreeRoot,
      O8_METADATA_REPO: fixtureValue.repoPath,
      O8_METADATA_HOLD: hold ? '1' : '0',
      NODE_OPTIONS: [inheritedNodeOptions, '--conditions=react-server'].filter(Boolean).join(' '),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = new ChildOutput(child);
  children.push(output);
  return output;
}

async function initializeLeaseSchema(repoPath: string): Promise<void> {
  await withWorktreeMetaTransaction(repoPath, async () => undefined);
}

afterEach(() => {
  for (const output of children.splice(0)) {
    if (output.child.exitCode === null && output.child.signalCode === null) output.child.kill('SIGKILL');
  }
  if (priorDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = priorDataDir;
  if (priorO8DataDir === undefined) delete process.env.O8_DATA_DIR;
  else process.env.O8_DATA_DIR = priorO8DataDir;
  if (priorDbPath === undefined) delete process.env.CORTEX_IDE_DB_PATH;
  else process.env.CORTEX_IDE_DB_PATH = priorDbPath;
  if (priorWorktreeRoot === undefined) delete process.env.O8_WORKTREE_ROOT;
  else process.env.O8_WORKTREE_ROOT = priorWorktreeRoot;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('exact worktree metadata transaction authority', () => {
  it('orders two Node processes even when the legacy lock pathname is renamed and recreated', async () => {
    const f = fixture('path-swap');
    const first = launch(f, true);
    await first.waitFor('O8_METADATA_ENTERED');

    mkdirSync(f.lockPath, { recursive: true });
    writeFileSync(path.join(f.lockPath, 'holder.json'), 'legacy path is not authority\n');
    renameSync(f.lockPath, `${f.lockPath}.moved`);
    mkdirSync(f.lockPath);
    writeFileSync(path.join(f.lockPath, 'replacement'), 'replacement path\n');

    const second = launch(f, false);
    await second.waitFor('O8_METADATA_ATTEMPT');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(second.stdout).not.toContain('O8_METADATA_ENTERED');

    const firstExit = first.waitForExit();
    first.child.stdin.end('release\n');
    expect(await firstExit).toBe(0);
    await second.waitFor('O8_METADATA_ENTERED');
    expect(await second.waitForExit()).toBe(0);
  }, 30_000);

  it('reclaims the exact lease after its Node process is killed', async () => {
    const f = fixture('crash');
    const first = launch(f, true);
    await first.waitFor('O8_METADATA_ENTERED');
    const firstExit = first.waitForExit();
    first.child.kill('SIGKILL');
    expect(await firstExit).not.toBe(0);

    const replacement = launch(f, false);
    await replacement.waitFor('O8_METADATA_ENTERED');
    expect(await replacement.waitForExit()).toBe(0);
  }, 30_000);

  it('reclaims a lease whose live PID belongs to another process instance', async () => {
    const f = fixture('reused-pid');
    await initializeLeaseSchema(f.repoPath);
    const probe = await probeMetadataLockProcessIdentity(process.pid);
    expect(probe.state).toBe('live');
    if (probe.state !== 'live') throw new Error('Current test process identity is unavailable.');
    mkdirSync(f.metadataRoot, { recursive: true });
    const sqlite = new Database(f.databasePath);
    sqlite.prepare(`
      INSERT INTO worktree_metadata_leases (
        metadata_root, reservation_id, owner_pid, owner_identity_json, acquired_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      realpathSync(f.metadataRoot),
      'reused-owner',
      process.pid,
      JSON.stringify({ ...probe.identity, startId: `${probe.identity.startId}-prior` }),
      Date.now(),
    );
    sqlite.close();

    await expect(withWorktreeMetaTransaction(f.repoPath, async () => 'acquired'))
      .resolves.toBe('acquired');
  });

  it('fails closed when the persisted owner identity is corrupt', async () => {
    const f = fixture('corrupt-owner');
    await initializeLeaseSchema(f.repoPath);
    mkdirSync(f.metadataRoot, { recursive: true });
    const sqlite = new Database(f.databasePath);
    sqlite.prepare(`
      INSERT INTO worktree_metadata_leases (
        metadata_root, reservation_id, owner_pid, owner_identity_json, acquired_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(realpathSync(f.metadataRoot), 'corrupt-owner', process.pid, '{invalid', Date.now());
    sqlite.close();

    await expect(withWorktreeMetaTransaction(f.repoPath, async () => 'unexpected'))
      .rejects.toThrow('corrupt owner identity');
  });
});
