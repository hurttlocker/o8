import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it } from 'vitest';

const root = mkdtempSync(path.join(tmpdir(), 'o8-remote-services-'));
process.env.O8_DATA_DIR = root;
process.env.CORTEX_IDE_DATA_DIR = root;
process.env.O8_CLOUD_JOB_LEASE_MS = '5000';

const { createCloudWorkerKey } = await import('@/lib/cloud/worker-auth');
const { getJob, readJobEvents } = await import('@/lib/cloud/job-queue');
const { closeDb } = await import('@/lib/db');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { resolveRemoteManifestHash } = await import('@/lib/cloud/remote-manifest');
const { cloudRuntime } = await import('@/lib/runtimes/cloud-adapter');
const { addRepo } = await import('@/lib/repos/registry');
const pollRoute = await import('@/app/api/cloud/worker-poll/route');
const streamRoute = await import('@/app/api/cloud/worker-stream/route');
const controlRoute = await import('@/app/api/cloud/worker-control/route');
const { startWorkspaceServices } = await import('../scripts/worker/workspace-services');

const key = createCloudWorkerKey({ teamId: 'team_default', label: 'service fixture' });

async function bridge() {
  const server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const request = new NextRequest(`http://127.0.0.1${incoming.url ?? '/'}`, {
      method: incoming.method,
      headers: new Headers(incoming.headers as HeadersInit),
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
    const pathname = new URL(request.url).pathname;
    const response = pathname === '/api/cloud/worker-poll' ? await pollRoute.GET(request)
      : pathname === '/api/cloud/worker-stream' ? await streamRoute.POST(request)
        : pathname === '/api/cloud/worker-control'
          ? incoming.method === 'POST' ? await controlRoute.POST(request) : await controlRoute.GET(request)
          : new Response('Not found', { status: 404 });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitFor<T>(read: () => T | null): Promise<T> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for external worker service receipt.');
}

afterAll(() => { closeDb(); rmSync(root, { recursive: true, force: true }); });

describe('leased remote workspace services', () => {
  it('authorizes exact base bytes, runs through the built worker, and stops the service before completion', async () => {
    const repo = path.join(root, 'repo');
    const bare = path.join(root, 'remote.git');
    const bin = path.join(root, 'bin');
    const workerRoot = path.join(root, 'worker');
    const port = await freePort();
    mkdirSync(repo); mkdirSync(bin);
    const manifest = {
      version: 1,
      setup: ['node -e "require(\'fs\').writeFileSync(\'setup-proof.txt\', \'ready\')"'],
      services: [{
        name: 'web',
        command: 'node service.js',
        port: { preferred: port, env: 'PORT' },
        health: { http: `http://127.0.0.1:${port}/health`, timeoutMs: 10_000 },
      }],
      preview: { url: `http://127.0.0.1:${port}` },
    };
    writeFileSync(path.join(repo, 'o8.workspace.json'), `${JSON.stringify(manifest)}\n`);
    writeFileSync(path.join(repo, 'service.js'), "require('http').createServer((req,res)=>{res.end(req.url==='/health'?'ok':'app')}).listen(process.env.PORT,'127.0.0.1')\n");
    execFileSync('git', ['init', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Service Test']);
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, 'commit', '-m', 'test: service fixture']);
    const baseSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    execFileSync('git', ['init', '--bare', bare]);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', bare]);
    execFileSync('git', ['-C', repo, 'push', 'origin', 'HEAD:refs/heads/main']);
    const remoteUrl = 'https://example.invalid/worker/service.git';
    execFileSync('git', ['-C', repo, 'remote', 'set-url', 'origin', remoteUrl]);
    await addRepo(repo);

    await updateOperatorDefaults({ workspaceManifestPolicy: 'disabled' });
    expect(await resolveRemoteManifestHash(repo, baseSha)).toBeUndefined();
    await updateOperatorDefaults({ workspaceManifestPolicy: 'one-approval' });
    await expect(resolveRemoteManifestHash(repo, baseSha)).rejects.toThrow('require approval');
    const unapproved = await cloudRuntime.launch({
      cwd: repo, sourceRepoPath: repo, prompt: 'Must not enqueue yet.',
      packetId: 'packet-service-unapproved', branchName: 'o8/service-unapproved', workMode: 'edit',
    });
    expect(unapproved).toMatchObject({ ok: false, sideEffect: 'none' });
    await updateOperatorDefaults({ workspaceManifestPolicy: 'auto' });
    const hash = await resolveRemoteManifestHash(repo, baseSha);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);

    const fakeCodex = path.join(bin, 'codex');
    writeFileSync(fakeCodex, [
      '#!/usr/bin/env node',
      "if (process.env.O8_CLOUD_WORKER_KEY) process.exit(19);",
      "process.stdin.resume(); process.stdin.on('end',()=>{",
      "  setTimeout(()=>{require('fs').writeFileSync('codex-proof.txt','done');",
      "    process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}})+'\\n');",
      '  }, 500);',
      '});',
    ].join('\n'));
    chmodSync(fakeCodex, 0o755);
    execFileSync(process.execPath, ['scripts/build-worker.mjs'], { cwd: process.cwd() });
    const http = await bridge();
    const worker = spawn(process.execPath, [
      path.join(process.cwd(), 'dist/worker/o8-worker.mjs'),
      '--o8-url', http.url, '--workspace-dir', workerRoot,
      '--poll-interval-ms', '1000', '--control-poll-interval-ms', '1000',
    ], {
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, O8_CLOUD_WORKER_KEY: key.plaintext,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `url.file://${bare}/.insteadOf`,
        GIT_CONFIG_VALUE_0: remoteUrl,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let workerOutput = '';
    worker.stderr.on('data', (chunk: Buffer) => { workerOutput += chunk.toString(); });
    try {
      const launched = await cloudRuntime.launch({
        cwd: repo, sourceRepoPath: repo, prompt: 'Start a checked service.', packetId: 'packet-service-test', workMode: 'edit',
        branchName: 'o8/service-test', baseBranch: 'HEAD',
      });
      expect(launched.ok).toBe(true);
      const jobId = launched.sessionKey!.replace(/^cloud:/, '');
      expect(getJob('team_default', jobId)?.launch.remoteManifestHash).toBe(hash);
      await waitFor(() => getJob('team_default', jobId)?.status === 'completed' ? true : null);
      const events = readJobEvents('team_default', jobId);
      expect(events.filter((event) => event.type === 'service').map((event) => event.payload))
        .toEqual([
          expect.objectContaining({ name: 'web', state: 'healthy', manifestHash: hash, claimCount: 1, health: true }),
          expect.objectContaining({ name: 'web', state: 'stopped', manifestHash: hash, claimCount: 1, health: false }),
        ]);
      expect(events.findIndex((event) => event.type === 'service' && (event.payload as { state: string }).state === 'stopped'))
        .toBeLessThan(events.findIndex((event) => event.type === 'completed'));
      await waitFor(() => {
        try { execFileSync('node', ['-e', `require('net').connect(${port},'127.0.0.1').on('connect',()=>process.exit(1)).on('error',()=>process.exit(0))`]); return true; }
        catch { return null; }
      });
      expect(execFileSync('git', ['--git-dir', bare, 'show', 'refs/heads/o8/service-test:codex-proof.txt'], { encoding: 'utf8' }))
        .toBe('done');
      const stale = await streamRoute.POST(new NextRequest('http://localhost/api/cloud/worker-stream', {
        method: 'POST',
        headers: { authorization: `Bearer ${key.plaintext}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jobId, workerId: 'forged', leaseToken: 'old', type: 'service', payload: {
          name: 'web', state: 'healthy', commandId: 'a'.repeat(64), manifestHash: hash,
          claimCount: 1, port, health: true,
        } }),
      }));
      expect(stale.status).toBe(409);
      expect(workerOutput).not.toContain(key.plaintext);
    } finally {
      worker.kill('SIGTERM');
      await new Promise<void>((resolve) => worker.once('exit', () => resolve()));
      await http.close();
    }
  }, 60_000);

  it('rejects changed clone bytes before executing setup or service commands', async () => {
    const cloneDir = path.join(root, 'wrong-hash');
    mkdirSync(cloneDir);
    writeFileSync(path.join(cloneDir, 'o8.workspace.json'), '{"version":1,"setup":["touch should-not-run"]}');
    await expect(startWorkspaceServices({
      cloneDir,
      job: { id: 'wrong', claimCount: 1, leaseToken: 'lease', leaseExpiresAt: new Date().toISOString(), cursor: 1,
        launch: { prompt: '', remoteManifestHash: 'a'.repeat(64) } },
      stream: { postEvent: async () => null } as never,
      signal: new AbortController().signal,
    })).rejects.toThrow('differs from the authorized base revision');
  });

  it('bounds a setup command that ignores termination', async () => {
    if (process.platform === 'win32') return;
    const cloneDir = path.join(root, 'stubborn-setup');
    mkdirSync(cloneDir);
    const source = JSON.stringify({
      version: 1,
      setup: ['node -e "process.on(\'SIGTERM\',()=>{}); setInterval(()=>{},1000)"'],
    });
    writeFileSync(path.join(cloneDir, 'o8.workspace.json'), source);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const started = Date.now();
    await expect(startWorkspaceServices({
      cloneDir,
      job: { id: 'stubborn', claimCount: 1, leaseToken: 'lease', leaseExpiresAt: new Date().toISOString(), cursor: 1,
        launch: { prompt: '', remoteManifestHash: createHash('sha256').update(source).digest('hex') } },
      stream: { postEvent: async () => null } as never,
      signal: controller.signal,
    })).rejects.toThrow('cancelled');
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it('kills a background setup child when its shell exits successfully', async () => {
    if (process.platform === 'win32') return;
    const cloneDir = path.join(root, 'background-setup');
    mkdirSync(cloneDir);
    const port = await freePort();
    const background = `node -e "process.on('SIGTERM',()=>{}); require('http').createServer((_,r)=>r.end('ok')).listen(${port},'127.0.0.1',()=>require('fs').writeFileSync('background.ready','yes'))" & while [ ! -f background.ready ]; do sleep 0.01; done`;
    const source = JSON.stringify({ version: 1, setup: [background] });
    writeFileSync(path.join(cloneDir, 'o8.workspace.json'), source);
    const running = await startWorkspaceServices({
      cloneDir,
      job: { id: 'background', claimCount: 1, leaseToken: 'lease', leaseExpiresAt: new Date().toISOString(), cursor: 1,
        launch: { prompt: '', remoteManifestHash: createHash('sha256').update(source).digest('hex') } },
      stream: { postEvent: async () => null } as never,
      signal: new AbortController().signal,
    });
    await expect(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
    await running?.stop();
  }, 10_000);
});
