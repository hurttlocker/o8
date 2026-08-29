import { execFileSync, spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PacketReceipt, UnsignedPacketReceipt } from '@/lib/receipts/types';

interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const testHome = mkdtempSync(path.join(os.tmpdir(), 'o8-truth-cli-real-path-'));
const dataDir = path.join(testHome, '.o8');
const repoAPath = path.join(testHome, 'repo-a');
const repoBPath = path.join(testHome, 'repo-b');
const saveDir = path.join(testHome, 'saved-receipts');
const operatorToken = 'truth-cli-operator-token';
const originalHome = process.env.HOME;
const originalO8DataDir = process.env.O8_DATA_DIR;
const originalCortexDataDir = process.env.CORTEX_IDE_DATA_DIR;

mkdirSync(dataDir, { recursive: true });
writeFileSync(path.join(dataDir, 'ws-token'), `${operatorToken}\n`, 'utf8');
process.env.HOME = testHome;
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const truthRoute = await import('@/app/api/orchestrator/truth/route');
const broadcastTokensRoute = await import('@/app/api/broadcast/tokens/route');
const { closeDb } = await import('@/lib/db');
const {
  artifactAbsPath,
  artifactRelPath,
  ensureArtifactBucket,
  recordArtifact,
} = await import('@/lib/artifacts/store');
const { canonicalJson } = await import('@/lib/receipts/canonical');
const { getReceiptIdentity, signReceiptBytes } = await import('@/lib/receipts/receipt-identity');

let apiServer: Server | null = null;
let apiPort = 0;
let spectatorToken = '';
let receiptAPath = '';
let receiptA: PacketReceipt;

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function initRepo(repoPath: string): void {
  execFileSync('git', ['init', '--initial-branch=main', repoPath], { cwd: testHome, stdio: 'pipe' });
  git(repoPath, ['config', 'user.name', 'o8-test']);
  git(repoPath, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(path.join(repoPath, 'truth.txt'), `${path.basename(repoPath)}\n`, 'utf8');
  git(repoPath, ['add', 'truth.txt']);
  git(repoPath, ['commit', '-m', 'truth fixture']);
}

function persistReceipt(input: {
  packetId: string;
  repoName: string;
  repoRemote: string;
  repoPath: string;
}): { receipt: PacketReceipt; receiptPath: string } {
  const identity = getReceiptIdentity();
  const mergeCommit = git(input.repoPath, ['rev-parse', 'HEAD']);
  const tree = git(input.repoPath, ['rev-parse', 'HEAD^{tree}']);
  const createdAt = new Date().toISOString();
  const unsigned: UnsignedPacketReceipt = {
    schema: 'o8/packet-receipt/v1',
    receiptId: `receipt-${input.packetId}`,
    packetId: input.packetId,
    packetTitle: `Truth fixture ${input.repoName}`,
    laneId: `lane-${input.packetId}`,
    repo: {
      name: input.repoName,
      remote: input.repoRemote,
      baseBranch: 'main',
    },
    disposition: {
      kind: 'merged',
      mergeCommit,
      headSha: mergeCommit,
      tree,
      evidenceKind: 'merge_command',
      releasedAt: createdAt,
    },
    reviews: [{
      turnId: `review-${input.packetId}`,
      backend: 'codex',
      outcome: 'completed',
      at: createdAt,
    }],
    approvals: [{
      id: `approval-${input.packetId}`,
      title: 'Merge packet',
      principal: 'operator',
      decision: 'approved',
      at: createdAt,
    }],
    runtime: 'codex',
    model: 'truth-real-path-model',
    createdAt,
    keyId: identity.keyId,
  };
  const receipt: PacketReceipt = {
    ...unsigned,
    signature: signReceiptBytes(
      new TextEncoder().encode(canonicalJson(unsigned)),
      identity.secretKey,
    ),
  };
  ensureArtifactBucket(input.packetId);
  const relPath = artifactRelPath(input.packetId, receipt.receiptId, 'json');
  const receiptPath = artifactAbsPath(relPath);
  const rawReceiptJson = `${canonicalJson(receipt)}\n`;
  writeFileSync(receiptPath, rawReceiptJson, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const artifact = recordArtifact({
    id: receipt.receiptId,
    kind: 'receipt',
    source: 'review-boundary',
    relPath,
    packetId: input.packetId,
    repoPath: input.repoPath,
    label: 'Signed packet receipt',
    mimeType: 'application/json',
    bytes: Buffer.byteLength(rawReceiptJson),
  });
  if (!artifact) throw new Error(`Unable to record receipt ${receipt.receiptId}.`);
  return { receipt, receiptPath };
}

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolveRun, reject) => {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: testHome,
      O8_DATA_DIR: dataDir,
      CORTEX_IDE_DATA_DIR: dataDir,
      O8_API_PORT: String(apiPort),
      O8_API_TOKEN: operatorToken,
      O8_SPECTATOR_TOKEN: spectatorToken,
      O8_WORKER_TOKEN: '',
      O8_WORKER_PACKET_ID: '',
    };
    delete childEnv.NODE_OPTIONS;
    const child = spawn(process.execPath, [path.join(process.cwd(), 'cli/dist/o8.mjs'), ...args], {
      cwd: repoAPath,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (exitCode) => resolveRun({ exitCode, stdout, stderr }));
  });
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function writeRouteResponse(response: ServerResponse, routeResponse: Response): Promise<void> {
  response.writeHead(routeResponse.status, {
    'Content-Type': routeResponse.headers.get('Content-Type') ?? 'application/json',
    'Cache-Control': routeResponse.headers.get('Cache-Control') ?? 'no-store',
  });
  response.end(await routeResponse.text());
}

beforeAll(async () => {
  initRepo(repoAPath);
  initRepo(repoBPath);
  const storedA = persistReceipt({
    packetId: 'packet-truth-a',
    repoName: 'repo-a',
    repoRemote: 'example.test/team/repo-a',
    repoPath: repoAPath,
  });
  receiptA = storedA.receipt;
  receiptAPath = storedA.receiptPath;
  persistReceipt({
    packetId: 'packet-truth-b',
    repoName: 'repo-b',
    repoRemote: 'example.test/team/repo-b',
    repoPath: repoBPath,
  });
  const identity = getReceiptIdentity();
  writeFileSync(path.join(dataDir, 'receipt-public.key'), `${identity.publicKeyB64}\n`, 'utf8');

  const mintedResponse = await broadcastTokensRoute.POST(new NextRequest(
    'http://localhost:3001/api/broadcast/tokens',
    {
      method: 'POST',
      headers: {
        host: 'localhost:3001',
        authorization: `Bearer ${operatorToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        action: 'mint',
        label: 'truth CLI',
        repoGrants: ['example.test/team/repo-a'],
      }),
    },
  ));
  expect(mintedResponse.status).toBe(200);
  spectatorToken = ((await mintedResponse.json()) as { bearer: string }).bearer;

  execFileSync(process.execPath, [path.join(process.cwd(), 'cli/esbuild.config.mjs')], {
    cwd: process.cwd(),
    stdio: 'ignore',
  });
  apiServer = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', `http://127.0.0.1:${apiPort}`);
      const body = await readBody(request);
      const nextRequest = new NextRequest(requestUrl, {
        method: request.method,
        headers: request.headers as HeadersInit,
        body: body || undefined,
      });
      if (requestUrl.pathname === '/api/orchestrator/truth' && request.method === 'GET') {
        await writeRouteResponse(response, await truthRoute.GET(nextRequest));
      } else {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'missing fixture route' }));
      }
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  await new Promise<void>((resolveListen) => apiServer!.listen(0, '127.0.0.1', resolveListen));
  const address = apiServer.address();
  if (!address || typeof address === 'string') throw new Error('Truth fixture server did not bind.');
  apiPort = address.port;
}, 30_000);

afterAll(async () => {
  if (apiServer) {
    const server = apiServer;
    apiServer = null;
    await new Promise<void>((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
    });
  }
  closeDb();
  rmSync(testHome, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalO8DataDir === undefined) delete process.env.O8_DATA_DIR;
  else process.env.O8_DATA_DIR = originalO8DataDir;
  if (originalCortexDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = originalCortexDataDir;
});

describe.sequential('truth CLI real path', () => {
  it('uses the scoped spectator over the operator token, saves exact bytes, and verifies offline', async () => {
    const human = await runCli(['truth', 'merged', '--repo', 'repo-a', '--since', '7d', '--human']);
    expect(human.exitCode, human.stderr).toBe(0);
    expect(human.stdout).toContain(`receipt      ${receiptA.receiptId}`);
    expect(human.stdout).toContain('disposition  merged');

    const allowed = await runCli([
      'truth', 'merged', '--repo', 'repo-a', '--since', '7d', '--save-receipts', saveDir,
    ]);
    expect(allowed.exitCode, allowed.stderr).toBe(0);
    const payload = JSON.parse(allowed.stdout) as {
      schema: string;
      answers: Array<{
        receipt: PacketReceipt;
        receiptRaw: string;
        savedReceiptPath: string;
        verifyCommand: string;
      }>;
    };
    expect(payload.schema).toBe('o8/cli/truth.query/v1');
    const answer = payload.answers.find((candidate) => candidate.receipt.receiptId === receiptA.receiptId);
    expect(answer).toBeDefined();
    expect(answer!.receiptRaw).toBe(readFileSync(receiptAPath, 'utf8'));
    expect(readFileSync(answer!.savedReceiptPath)).toEqual(readFileSync(receiptAPath));
    expect(answer!.verifyCommand).toBe(`o8 verify ${answer!.savedReceiptPath}`);

    const denied = await runCli(['truth', 'merged', '--repo', 'repo-b', '--since', '7d']);
    expect(denied.exitCode).toBe(3);
    expect(denied.stderr).toContain(
      'The spectator credential is not granted to the requested repository.',
    );

    const verified = await runCli(['verify', answer!.savedReceiptPath, '--repo', repoAPath]);
    expect(verified.exitCode, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({
      schema: 'o8/cli/receipt.verify/v1',
      receiptId: receiptA.receiptId,
      ok: true,
      signatureValid: true,
      keyIdMatches: true,
      repository: { checked: true, commitExists: true, treeMatches: true },
    });
  }, 30_000);
});
