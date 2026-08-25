import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-cloud-job-spine-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_CLOUD_JOB_LEASE_MS = '100';

const runtimeRoute = await import('@/app/api/runtime/launch/route');
const pollRoute = await import('@/app/api/cloud/worker-poll/route');
const streamRoute = await import('@/app/api/cloud/worker-stream/route');
const { createCloudWorkerKey } = await import('@/lib/cloud/worker-auth');
const { getJob } = await import('@/lib/cloud/job-queue');
const { closeDb } = await import('@/lib/db');
const { cloudRuntime } = await import('@/lib/runtimes/cloud-adapter');

const workerKey = createCloudWorkerKey({ teamId: 'team_default', label: 'durable spine test' });

interface PollResult {
  status: number;
  body: {
    job?: {
      id: string;
      claimedBy: string;
      leaseToken: string;
      leaseExpiresAt: string;
    };
  } | null;
}

class PollChild {
  readonly child: ChildProcessWithoutNullStreams;
  stdout = '';
  stderr = '';

  constructor(workerId: string) {
    const routeUrl = pathToFileURL(join(process.cwd(), 'src/app/api/cloud/worker-poll/route.ts')).href;
    const script = `
      import { NextRequest } from 'next/server';
      const routeModule = await import(${JSON.stringify(routeUrl)});
      const GET = routeModule.GET ?? routeModule.default?.GET;
      process.stdout.write('READY\\n');
      process.stdin.once('data', async () => {
        const request = new NextRequest(
          'http://localhost/api/cloud/worker-poll?cursor=0&waitMs=0&workerId=' + encodeURIComponent(process.env.O8_TEST_WORKER_ID),
          { headers: { authorization: 'Bearer ' + process.env.O8_TEST_CLOUD_TOKEN } },
        );
        const response = await GET(request);
        const body = response.status === 204 ? null : await response.json();
        process.stdout.write('RESULT ' + JSON.stringify({ status: response.status, body }) + '\\n');
      });
    `;
    this.child = spawn(process.execPath, ['--import=tsx', '--input-type=module', '--eval', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--conditions=react-server'].filter(Boolean).join(' '),
        O8_TEST_WORKER_ID: workerId,
        O8_TEST_CLOUD_TOKEN: workerKey.plaintext,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => { this.stdout += chunk; });
    this.child.stderr.on('data', (chunk: string) => { this.stderr += chunk; });
  }

  async waitFor(text: string): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (!this.stdout.includes(text)) {
      if (this.child.exitCode !== null) {
        throw new Error(`Poll child exited before ${text}: ${this.stdout}${this.stderr}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${text}: ${this.stdout}${this.stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async result(): Promise<PollResult> {
    await this.waitFor('RESULT ');
    const line = this.stdout.split('\n').find((entry) => entry.startsWith('RESULT '));
    if (!line) throw new Error(`Poll child returned no result: ${this.stdout}${this.stderr}`);
    return JSON.parse(line.slice('RESULT '.length)) as PollResult;
  }

  async waitForExit(): Promise<number | null> {
    if (this.child.exitCode !== null) return this.child.exitCode;
    return new Promise((resolve) => this.child.once('exit', resolve));
  }
}

function runtimeLaunch(body: Record<string, unknown>) {
  return runtimeRoute.POST(new NextRequest('http://localhost/api/runtime/launch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

function workerPoll(workerId: string, cursor: number = 0) {
  return pollRoute.GET(new NextRequest(
    `http://localhost/api/cloud/worker-poll?cursor=${cursor}&waitMs=0&workerId=${encodeURIComponent(workerId)}`,
    { headers: { authorization: `Bearer ${workerKey.plaintext}` } },
  ));
}

function workerStream(body: Record<string, unknown>) {
  return streamRoute.POST(new NextRequest('http://localhost/api/cloud/worker-stream', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${workerKey.plaintext}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }));
}

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('durable cloud execution through the runtime launch path', () => {
  it('survives restart, serializes claims, recovers a lease, and retains output', async () => {
    const packetId = 'packet-durable-cloud-spine';
    const launch = await runtimeLaunch({
      runtime: 'cloud',
      prompt: 'Produce durable remote output.',
      cwd: dataDir,
      repoPath: dataDir,
      skipSetup: true,
      packetId,
      clientMutationId: 'cloud-spine-launch-1',
    });
    expect(launch.status).toBe(200);
    const launchBody = await launch.json() as { surfaceId: string };
    const jobId = launchBody.surfaceId.replace(/^cloud:/, '');

    const duplicatePacket = await runtimeLaunch({
      runtime: 'cloud',
      prompt: 'This packet must not run concurrently.',
      cwd: dataDir,
      repoPath: dataDir,
      skipSetup: true,
      packetId,
      clientMutationId: 'cloud-spine-launch-2',
    });
    expect(duplicatePacket.status).toBe(400);
    await expect(duplicatePacket.json()).resolves.toMatchObject({
      ok: false,
      surfaceId: launchBody.surfaceId,
      note: expect.stringContaining('already has active cloud job'),
    });

    closeDb();
    expect(getJob('team_default', jobId)).toMatchObject({
      id: jobId,
      packetId,
      status: 'pending',
      executionAttempts: 0,
    });

    const contenders = [new PollChild('worker-a'), new PollChild('worker-b')];
    await Promise.all(contenders.map((child) => child.waitFor('READY')));
    for (const child of contenders) child.child.stdin.end('go\n');
    const results = await Promise.all(contenders.map((child) => child.result()));
    await Promise.all(contenders.map((child) => child.waitForExit()));

    expect(results.map((result) => result.status).sort()).toEqual([200, 204]);
    const firstClaim = results.find((result) => result.status === 200)?.body?.job;
    expect(firstClaim).toMatchObject({ id: jobId });
    expect(firstClaim?.leaseToken).toBeTruthy();
    expect(getJob('team_default', jobId)).toMatchObject({
      status: 'leased',
      claimCount: 1,
      executionAttempts: 0,
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    const recoveredPoll = await workerPoll('worker-recovery', 9_999);
    expect(recoveredPoll.status).toBe(200);
    const recoveredClaim = (await recoveredPoll.json() as PollResult['body'])?.job;
    expect(recoveredClaim).toMatchObject({ id: jobId, claimedBy: 'worker-recovery' });
    expect(recoveredClaim?.leaseToken).not.toBe(firstClaim?.leaseToken);
    expect(getJob('team_default', jobId)).toMatchObject({
      status: 'leased',
      claimCount: 2,
      leaseRecoveryCount: 1,
      executionAttempts: 0,
    });

    const staleWorker = await workerStream({
      jobId,
      workerId: firstClaim?.claimedBy,
      leaseToken: firstClaim?.leaseToken,
      type: 'completed',
      payload: { result: 'stale completion' },
    });
    expect(staleWorker.status).toBe(409);
    await expect(staleWorker.json()).resolves.toMatchObject({ reason: 'lease_mismatch' });

    const output = await workerStream({
      jobId,
      workerId: recoveredClaim?.claimedBy,
      leaseToken: recoveredClaim?.leaseToken,
      type: 'chunk',
      payload: { text: 'durable worker output' },
    });
    expect(output.status).toBe(200);
    const completed = await workerStream({
      jobId,
      workerId: recoveredClaim?.claimedBy,
      leaseToken: recoveredClaim?.leaseToken,
      type: 'completed',
      payload: { result: 'remote work complete' },
    });
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toMatchObject({ status: 'completed' });

    closeDb();
    const transcript = await cloudRuntime.readTranscript(launchBody.surfaceId);
    expect(transcript.map((entry) => entry.text)).toEqual(expect.arrayContaining([
      'durable worker output',
      'remote work complete',
    ]));
    const session = (await cloudRuntime.discoverSessions())
      .find((candidate) => candidate.sessionKey === launchBody.surfaceId);
    expect(session).toMatchObject({
      status: 'completed',
      initialTask: expect.stringContaining('Produce durable remote output.'),
    });
    expect(getJob('team_default', jobId)).toMatchObject({
      status: 'completed',
      leaseRecoveryCount: 1,
      executionAttempts: 0,
    });
  }, 60_000);
});
