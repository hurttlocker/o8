import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'o8-worker-shutdown-'));
process.env.O8_DATA_DIR = root;
process.env.CORTEX_IDE_DATA_DIR = root;
process.env.O8_CLOUD_JOB_LEASE_MS = '3000';
const { createCloudWorkerKey } = await import('@/lib/cloud/worker-auth');
const { enqueueCloudJob, getJob, readJobEvents } = await import('@/lib/cloud/job-queue');
const { closeDb } = await import('@/lib/db');
const { listConnectedCloudWorkers } = await import('@/lib/cloud/worker-presence');
const poll = await import('@/app/api/cloud/worker-poll/route');
const stream = await import('@/app/api/cloud/worker-stream/route');
const control = await import('@/app/api/cloud/worker-control/route');
const key = createCloudWorkerKey({ teamId: 'team_default', label: 'shutdown fixture' });

beforeAll(() => { execFileSync(process.execPath, ['scripts/build-worker.mjs']); });
afterAll(() => { closeDb(); rmSync(root, { recursive: true, force: true }); });

async function until(check: () => boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Shutdown fixture timed out.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function isAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function bridge(immediateEmpty = false) {
  let polls = 0;
  let emptyResponses = 0;
  const waits: Array<number | null> = [];
  const server = createServer(async (incoming, outgoing) => {
    const disconnect = new AbortController();
    outgoing.once('close', () => disconnect.abort());
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const request = new NextRequest(`http://127.0.0.1${incoming.url}`, {
        method: incoming.method, headers: incoming.headers as HeadersInit,
        signal: disconnect.signal,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      const route = new URL(request.url).pathname;
      if (route === '/api/cloud/worker-poll') {
        polls += 1;
        const wait = new URL(request.url).searchParams.get('waitMs');
        waits.push(wait === null ? null : Number(wait));
      }
      const response = route === '/api/cloud/worker-poll'
        ? immediateEmpty ? new Response(null, { status: 204 }) : await poll.GET(request)
        : route === '/api/cloud/worker-stream' ? await stream.POST(request)
          : route === '/api/cloud/worker-control' ? await control.GET(request)
            : new Response(null, { status: 404 });
      if (!outgoing.destroyed) {
        if (route === '/api/cloud/worker-poll' && response.status === 204) emptyResponses += 1;
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      }
    } catch {
      if (!outgoing.destroyed) { outgoing.writeHead(500); outgoing.end(); }
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    polls: () => polls,
    waits: () => waits,
    emptyResponses: () => emptyResponses,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function runner(url: string, workspace: string, environment: Partial<NodeJS.ProcessEnv> = {}) {
  const child = spawn(process.execPath, [
    join(process.cwd(), 'dist/worker/o8-worker.mjs'), '--o8-url', url,
    '--workspace-dir', workspace, '--poll-interval-ms', '60000',
    '--control-poll-interval-ms', '1000',
  ], {
    env: { ...process.env, O8_CLOUD_WORKER_KEY: key.plaintext, ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  return { child, exited, output: () => output };
}

async function forceCleanup(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGKILL');
    await exited;
  }
}

describe.skipIf(process.platform === 'win32')('built durable worker shutdown', () => {
  it('finishes an authenticated empty poll below its request deadline without a false timeout', async () => {
    const http = await bridge();
    const workspace = join(root, 'healthy-idle');
    const worker = runner(http.url, workspace);
    try {
      await until(() => http.polls() === 1);
      expect(http.waits()[0]).toBeGreaterThan(0);
      expect(http.waits()[0]).toBeLessThan(12_000);
      await until(() => http.emptyResponses() === 1);
      closeDb();
      const identity = JSON.parse(readFileSync(join(workspace, 'worker-state.json'), 'utf8')) as { workerId: string; cursor: number };
      expect(listConnectedCloudWorkers()).toEqual(expect.arrayContaining([
        expect.objectContaining({ workerId: identity.workerId }),
      ]));
      expect(identity.cursor).toBe(0);
      expect(worker.output()).not.toContain('poll failed');
      worker.child.kill('SIGTERM');
      await until(() => worker.child.exitCode !== null, 2500);
      expect(await worker.exited).toBe(0);
      expect(http.polls()).toBe(1);
    } finally { await forceCleanup(worker.child); await http.close(); }
  }, 20_000);

  it.each([false, true])('interrupts an idle %s poll or delay without another claim', async (immediateEmpty) => {
    const http = await bridge(immediateEmpty);
    const worker = runner(http.url, join(root, `idle-${immediateEmpty}`));
    try {
      await until(() => http.polls() === 1);
      // Give the 204 response time to enter the 60-second backoff.
      if (immediateEmpty) await new Promise((resolve) => setTimeout(resolve, 100));
      worker.child.kill(immediateEmpty ? 'SIGINT' : 'SIGTERM');
      await until(() => worker.child.exitCode !== null, 2500);
      expect(await worker.exited).toBe(0);
      expect(http.polls()).toBe(1);
      expect(worker.output()).toContain('shutdown complete');
      expect(worker.output()).not.toContain(key.plaintext);
    } finally { await forceCleanup(worker.child); await http.close(); }
  });

  it('stops resistant Codex descendants and services, then recovers the same job in a fresh clone', async () => {
    const fixture = join(root, 'active');
    const repo = join(fixture, 'source');
    const bare = join(fixture, 'remote.git');
    const bin = join(fixture, 'bin');
    const workspace = join(fixture, 'worker');
    const pidFile = join(fixture, 'codex.pid');
    const descendantPidFile = join(fixture, 'descendant.pid');
    mkdirSync(repo, { recursive: true }); mkdirSync(bin);
    const reserve = createServer();
    await new Promise<void>((resolve) => reserve.listen(0, '127.0.0.1', resolve));
    const port = (reserve.address() as AddressInfo).port;
    await new Promise<void>((resolve) => reserve.close(() => resolve()));
    const manifest = `${JSON.stringify({ version: 1, services: [{
      name: 'web', command: 'node service.js', port: { preferred: port, env: 'PORT' },
      health: { http: `http://127.0.0.1:${port}/health` },
    }] })}\n`;
    writeFileSync(join(repo, 'o8.workspace.json'), manifest);
    writeFileSync(join(repo, 'service.js'), "require('http').createServer((req,res)=>res.end(String(process.pid))).listen(process.env.PORT,'127.0.0.1')\n");
    const git = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(['init']); git(['config', 'user.name', 'Worker Fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
    git(['add', '.']); git(['commit', '-m', 'test: shutdown source']);
    const sha = git(['rev-parse', 'HEAD']);
    execFileSync('git', ['init', '--bare', bare], { stdio: 'ignore' });
    git(['remote', 'add', 'origin', bare]); git(['push', 'origin', 'HEAD:refs/heads/main']);
    const codex = join(bin, 'codex');
    writeFileSync(codex, [
      '#!/usr/bin/env node',
      "const fs = require('fs'); const { spawn } = require('child_process');",
      "process.stdin.resume(); process.stdin.on('end', () => {",
      "  if (process.env.O8_TEST_COMPLETE === '1') { fs.writeFileSync('proof.txt', 'recovered'); return; }",
      "  fs.writeFileSync(process.env.O8_TEST_PID, String(process.pid));",
      "  spawn(process.execPath, ['-e', \"require('fs').writeFileSync(process.env.O8_TEST_DESCENDANT_PID, String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);\"], { stdio: 'ignore' });",
      "  process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
      '});',
    ].join('\n'));
    chmodSync(codex, 0o755);
    const environment = {
      PATH: `${bin}:${process.env.PATH ?? ''}`, O8_TEST_PID: pidFile,
      O8_TEST_DESCENDANT_PID: descendantPidFile,
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${bare}/.insteadOf`,
      GIT_CONFIG_VALUE_0: 'https://example.invalid/shutdown.git',
    };
    const jobId = 'shutdown-recovery-job';
    enqueueCloudJob('team_default', jobId, {
      cwd: repo, prompt: 'Run shutdown fixture.', packetId: 'shutdown-recovery-packet',
      remoteSource: { repoUrl: 'https://example.invalid/shutdown.git', baseSha: sha, branch: 'o8/shutdown-proof' },
      remoteManifestHash: createHash('sha256').update(manifest).digest('hex'),
    });
    const http = await bridge();
    let worker = runner(http.url, workspace, environment);
    let servicePid = 0;
    const ownedPids: number[] = [];
    try {
      await until(() => existsSync(descendantPidFile));
      ownedPids.push(Number(readFileSync(pidFile, 'utf8')), Number(readFileSync(descendantPidFile, 'utf8')));
      servicePid = Number(await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.text()));
      ownedPids.push(servicePid);
      const before = getJob('team_default', jobId)!;
      const saved = readFileSync(join(workspace, 'worker-state.json'), 'utf8');
      worker.child.kill('SIGTERM');
      await until(() => worker.child.exitCode !== null, 12_000);
      expect(await worker.exited).toBe(0);
      await until(() => ownedPids.every((pid) => !isAlive(pid)), 3000);
      await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
      closeDb();
      expect(getJob('team_default', jobId)).toMatchObject({ executionAttempts: 0 });
      expect(readJobEvents('team_default', jobId).some((event) => ['completed', 'errored'].includes(event.type))).toBe(false);
      expect(() => execFileSync('git', ['--git-dir', bare, 'rev-parse', '--verify', 'refs/heads/o8/shutdown-proof'], { stdio: 'pipe' })).toThrow();
      expect(worker.output()).not.toContain(key.plaintext);
      worker = runner(http.url, workspace, { ...environment, O8_TEST_COMPLETE: '1' });
      await until(() => getJob('team_default', jobId)?.status === 'completed');
      expect(readFileSync(join(workspace, 'worker-state.json'), 'utf8')).toBe(saved);
      expect(getJob('team_default', jobId)).toMatchObject({
        claimedBy: before.claimedBy, claimCount: 2, leaseRecoveryCount: 1, executionAttempts: 0,
      });
      expect(readdirSync(workspace).filter((name) => name.startsWith(`${jobId}-`))).toHaveLength(2);
      expect(execFileSync('git', ['--git-dir', bare, 'show', 'refs/heads/o8/shutdown-proof:proof.txt'], { encoding: 'utf8' })).toBe('recovered');
      worker.child.kill('SIGTERM');
      await until(() => worker.child.exitCode !== null, 2500);
    } finally {
      await forceCleanup(worker.child);
      for (const pid of ownedPids) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already stopped. */ } }
      await http.close();
    }
  }, 45_000);
});
