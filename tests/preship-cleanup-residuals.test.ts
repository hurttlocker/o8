import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain .mjs gate entry point
import { cleanupGate, loadTeardownProvesClean } from '../scripts/lib/preship-gate-cleanup.mjs';

const root = mkdtempSync(path.join(os.tmpdir(), 'o8-preship-cleanup-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function fixture() {
  const dataDir = mkdtempSync(path.join(root, 'profile-'));
  const worktree = path.join(dataDir, 'worktrees', 'packet-fixture');
  mkdirSync(worktree, { recursive: true });
  const work = path.join(worktree, 'uncommitted.txt');
  writeFileSync(work, 'recoverable work');
  const socketPath = path.join(dataDir, '..', `${path.basename(dataDir)}.sock`);
  writeFileSync(socketPath, 'fixture socket');
  writeFileSync(`${socketPath}.token`, 'fixture token');
  return { dataDir, work, socketPath };
}

describe('outer pre-ship cleanup preserves failed load evidence', () => {
  it('requires a complete clean teardown, not merely an available sample', () => {
    const clean = { teardown: { refused: 0, residuals: { counts: { lanes: 0, childProcesses: 0, worktrees: 0, listeners: 0 } } } };
    expect(loadTeardownProvesClean(clean)).toBe(true);
    expect(loadTeardownProvesClean(undefined)).toBe(false);
    expect(loadTeardownProvesClean({ available: true })).toBe(false);
    expect(loadTeardownProvesClean({ teardown: { ...clean.teardown, refused: 1 } })).toBe(false);
    expect(loadTeardownProvesClean({ teardown: {
      ...clean.teardown, residuals: { counts: { ...clean.teardown.residuals.counts, futureResource: 1 } },
    } })).toBe(false);
    for (const key of Object.keys(clean.teardown.residuals.counts)) {
      expect(loadTeardownProvesClean({ teardown: {
        ...clean.teardown, residuals: { counts: { ...clean.teardown.residuals.counts, [key]: 1 } },
      } })).toBe(false);
      expect(loadTeardownProvesClean({ teardown: {
        ...clean.teardown, residuals: { counts: { ...clean.teardown.residuals.counts, [key]: undefined } },
      } })).toBe(false);
    }
  });

  it('stops its real child but preserves residual work and removes its socket credentials', async () => {
    const files = fixture();
    const child = spawn(process.execPath, ['-e', `
      const net = require('node:net');
      const fs = require('node:fs');
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => {
        fs.writeFileSync(process.argv[1], String(server.address().port));
      });
    `, path.join(files.dataDir, 'api-port')], { detached: true, stdio: 'ignore' });
    try {
      await vi.waitFor(() => expect(existsSync(path.join(files.dataDir, 'api-port'))).toBe(true));
      await cleanupGate({ ...files, child, preserveDataDir: true });
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(readFileSync(files.work, 'utf8')).toBe('recoverable work');
      expect(existsSync(files.socketPath)).toBe(false);
      expect(existsSync(`${files.socketPath}.token`)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
    }
  });

  it('preserves the profile if the API listener has not shut down', async () => {
    const files = fixture();
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as net.AddressInfo;
    writeFileSync(path.join(files.dataDir, 'api-port'), String(address.port));
    try {
      await expect(cleanupGate(files)).rejects.toThrow('profile preserved');
      expect(readFileSync(files.work, 'utf8')).toBe('recoverable work');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('still removes an owned, clean profile on the normal cleanup path', async () => {
    const files = fixture();
    await cleanupGate(files);
    expect(existsSync(files.dataDir)).toBe(false);
    expect(existsSync(files.socketPath)).toBe(false);
    expect(existsSync(`${files.socketPath}.token`)).toBe(false);
  });
});
