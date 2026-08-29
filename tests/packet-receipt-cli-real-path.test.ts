import { execFileSync, spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { PacketReceipt } from '@/lib/receipts/types';

interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const testHome = mkdtempSync(path.join(os.tmpdir(), 'o8-packet-receipt-real-path-'));
const dataDir = path.join(testHome, '.o8');
const verifierHome = path.join(testHome, 'verifier-home');
const verifierDataDir = path.join(verifierHome, '.o8');
const repoPath = path.join(testHome, 'repo');
const receiptPath = path.join(testHome, 'packet-receipt.json');
const tamperedPath = path.join(testHome, 'packet-receipt-tampered.json');
const wrongKeyPath = path.join(testHome, 'packet-receipt-wrong-key.json');
const token = 'packet-receipt-real-path-token';
const workerToken = 'packet-receipt-worker-token';
const packetId = 'pkt-receipt-real-path';
const originalHome = process.env.HOME;
const originalO8DataDir = process.env.O8_DATA_DIR;
const originalCortexDataDir = process.env.CORTEX_IDE_DATA_DIR;

mkdirSync(dataDir, { recursive: true });
mkdirSync(verifierDataDir, { recursive: true });
writeFileSync(path.join(dataDir, 'ws-token'), `${token}\n`, 'utf8');
writeFileSync(path.join(dataDir, 'worker-token'), `${workerToken}\n`, 'utf8');
process.env.HOME = testHome;
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const lanesRoute = await import('@/app/api/lanes/route');
const receiptsRoute = await import('@/app/api/orchestrator/receipts/route');
const { closeDb } = await import('@/lib/db');
const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { canonicalJson } = await import('@/lib/receipts/canonical');
const {
  loadOrCreateReceiptIdentityAt,
  signReceiptBytes,
  verifyReceiptBytes,
} = await import('@/lib/receipts/receipt-identity');
const { setApiBase } = await import('@/lib/mcp/operator-handlers/shared');
const { handleOperatorMcpMessage } = await import('@/lib/mcp/operator-mcp-host');

let apiServer: Server | null = null;
let apiPort = 0;
let publishedKey: { publicKey: string; keyId: string } | null = null;

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function runCli(
  args: string[],
  options: { home?: string; data?: string; cwd?: string } = {},
): Promise<CliResult> {
  return new Promise((resolveRun, reject) => {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: options.home ?? testHome,
      O8_DATA_DIR: options.data ?? dataDir,
      CORTEX_IDE_DATA_DIR: options.data ?? dataDir,
      O8_API_PORT: String(apiPort),
      O8_API_TOKEN: token,
      O8_WORKER_TOKEN: '',
      O8_WORKER_PACKET_ID: '',
    };
    delete childEnv.NODE_OPTIONS;
    const child = spawn(process.execPath, [path.join(process.cwd(), 'cli/dist/o8.mjs'), ...args], {
      cwd: options.cwd ?? repoPath,
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

function expectNoLocalPaths(serialized: string): void {
  expect(serialized).not.toContain(testHome);
  expect(serialized).not.toContain(dataDir);
  expect(serialized).not.toContain(repoPath);
}

function receiptRouteRequest(method: 'GET' | 'POST', bearer: string): Promise<Response> {
  const url = method === 'GET'
    ? `http://127.0.0.1:${apiPort}/api/orchestrator/receipts?packetId=${packetId}`
    : `http://127.0.0.1:${apiPort}/api/orchestrator/receipts`;
  return fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    },
    body: method === 'POST' ? JSON.stringify({ packetId }) : undefined,
  });
}

function requirePublishedKey(): { publicKey: string; keyId: string } {
  if (!publishedKey) throw new Error('The receipt public key fixture was not created.');
  return publishedKey;
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

async function closeServer(): Promise<void> {
  if (!apiServer) return;
  const server = apiServer;
  apiServer = null;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

beforeAll(async () => {
  execFileSync('git', ['init', '--initial-branch=main', repoPath], { cwd: testHome, stdio: 'pipe' });
  git(['config', 'user.name', 'o8-test']);
  git(['config', 'user.email', 'o8@example.test']);
  git(['remote', 'add', 'origin', 'https://fixture-user:fixture-secret@example.test/operator/receipt-fixture.git']);
  writeFileSync(path.join(repoPath, 'receipt.txt'), 'signed packet receipt\n');
  git(['add', 'receipt.txt']);
  git(['commit', '-m', 'receipt fixture']);
  const mergeCommit = git(['rev-parse', 'HEAD']);
  const lane = createLane({
    repoPath,
    branch: 'inline/receipt-real-path',
    baseBranch: 'main',
    runtime: 'codex',
    packetId,
    label: 'Receipt real path',
  });
  setLaneStatus(lane.id, 'completed', 'system', 'merged');
  writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(),
    missionId: 'mission-receipt-real-path',
    repoPath,
    runtime: 'codex',
    packets: [{
      id: packetId,
      referenceLabel: 'PKT-RECEIPT',
      title: 'Signed receipt fixture',
      summary: 'Persist a released packet for the compiled CLI real path.',
      workspaceTargetPath: repoPath,
      branchTarget: lane.branch,
      runtime: 'codex',
      model: 'receipt-test-model',
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'held',
      releaseState: 'released',
      releaseStatePayload: {
        source: 'approve_and_merge',
        mergeCommit,
        headSha: mergeCommit,
        evidenceKind: 'merge_command',
        releasedAt: '2026-08-29T19:30:00.000Z',
      },
      status: 'released',
      blockedReason: null,
      lane: null,
      review: null,
    } as OrchestratorPacket],
    updatedAt: new Date().toISOString(),
  });

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
      if (requestUrl.pathname === '/api/lanes' && request.method === 'GET') {
        await writeRouteResponse(response, await lanesRoute.GET(nextRequest));
      } else if (requestUrl.pathname === '/api/orchestrator/receipts' && request.method === 'GET') {
        await writeRouteResponse(response, await receiptsRoute.GET(nextRequest));
      } else if (requestUrl.pathname === '/api/orchestrator/receipts' && request.method === 'POST') {
        await writeRouteResponse(response, await receiptsRoute.POST(nextRequest));
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
  if (!address || typeof address === 'string') throw new Error('Receipt fixture server did not bind.');
  apiPort = address.port;
  setApiBase(`http://127.0.0.1:${apiPort}`);
}, 30_000);

afterAll(async () => {
  await closeServer();
  closeDb();
  rmSync(testHome, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalO8DataDir === undefined) delete process.env.O8_DATA_DIR;
  else process.env.O8_DATA_DIR = originalO8DataDir;
  if (originalCortexDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = originalCortexDataDir;
});

describe.sequential('packet receipt CLI real path', () => {
  it('enforces operator-only routes, omits local paths, and verifies offline', async () => {
    expect((await receiptRouteRequest('GET', workerToken)).status).toBe(403);
    expect((await receiptRouteRequest('POST', workerToken)).status).toBe(403);

    const operatorPost = await receiptRouteRequest('POST', token);
    expect(operatorPost.status).toBe(200);
    const operatorPostPayload = await operatorPost.json() as {
      ok: boolean;
      result: { receipt: PacketReceipt };
    };
    expect(operatorPostPayload).toMatchObject({
      ok: true,
      result: { receipt: { packetId, disposition: { kind: 'merged' } } },
    });
    const operatorGet = await receiptRouteRequest('GET', token);
    expect(operatorGet.status).toBe(200);
    expect(await operatorGet.json()).toMatchObject({
      ok: true,
      result: { packetId, count: 1 },
    });

    const mcpCreate = await handleOperatorMcpMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'o8_packet_receipt', arguments: { packetId } },
    });
    const mcpCreateText = (mcpCreate?.result as { content: Array<{ text: string }> }).content[0]!.text;
    const mcpCreatePayload = JSON.parse(mcpCreateText) as {
      ok: boolean;
      result: { relPath: string; receipt: PacketReceipt };
    };
    expect(mcpCreatePayload.ok).toBe(true);
    expect(mcpCreatePayload.result.receipt.disposition).toMatchObject({
      kind: 'merged',
      mergeCommit: git(['rev-parse', 'HEAD']),
      tree: git(['rev-parse', 'HEAD^{tree}']),
    });
    expect(mcpCreatePayload.result.receipt.repo).toEqual({
      name: 'repo',
      remote: 'example.test/operator/receipt-fixture',
      baseBranch: 'main',
    });
    expect('path' in mcpCreatePayload.result.receipt.repo).toBe(false);
    expectNoLocalPaths(JSON.stringify(mcpCreatePayload.result.receipt));
    expectNoLocalPaths(readFileSync(path.join(dataDir, mcpCreatePayload.result.relPath), 'utf8'));
    expect(path.isAbsolute(mcpCreatePayload.result.relPath)).toBe(false);

    const showKeyOnline = await runCli(['verify', '--show-key']);
    expect(showKeyOnline.exitCode, showKeyOnline.stderr).toBe(0);
    const keyPayload = JSON.parse(showKeyOnline.stdout) as { publicKey: string; keyId: string };
    publishedKey = keyPayload;
    expect(keyPayload.keyId).toBe(mcpCreatePayload.result.receipt.keyId);

    const mcpVerify = await handleOperatorMcpMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'o8_verify_receipt',
        arguments: {
          receiptPath: path.join(dataDir, mcpCreatePayload.result.relPath),
          key: keyPayload.publicKey,
          repoPath,
        },
      },
    });
    const mcpVerifyText = (mcpVerify?.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(JSON.parse(mcpVerifyText)).toMatchObject({
      ok: true,
      signatureValid: true,
      keyIdMatches: true,
      repository: { checked: true, commitExists: true, treeMatches: true },
    });

    const created = await runCli(['packet', 'receipt', packetId, '--out', receiptPath]);
    expect(created.exitCode, created.stderr).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({
      schema: 'o8/cli/packet.receipt/v1',
      packetId,
      path: receiptPath,
      receipt: { keyId: keyPayload.keyId, disposition: { kind: 'merged' } },
    });
    expect(existsSync(receiptPath)).toBe(true);
    expectNoLocalPaths(readFileSync(receiptPath, 'utf8'));

    const listed = await runCli(['packet', 'receipts', packetId]);
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({
      schema: 'o8/cli/packet.receipts/v1',
      packetId,
      count: 1,
    });

    writeFileSync(path.join(verifierDataDir, 'receipt-public.key'), `${keyPayload.publicKey}\n`, 'utf8');
    await closeServer();

    const accepted = await runCli(
      ['verify', receiptPath, '--repo', repoPath],
      { home: verifierHome, data: verifierDataDir },
    );
    expect(accepted.exitCode, accepted.stderr).toBe(0);
    expect(JSON.parse(accepted.stdout)).toMatchObject({
      schema: 'o8/cli/receipt.verify/v1',
      ok: true,
      signatureValid: true,
      keyIdMatches: true,
      repository: { checked: true, commitExists: true, treeMatches: true },
    });

    const showKeyOffline = await runCli(
      ['verify', '--show-key'],
      { home: verifierHome, data: verifierDataDir },
    );
    expect(showKeyOffline.exitCode, showKeyOffline.stderr).toBe(0);
    expect(JSON.parse(showKeyOffline.stdout)).toEqual({
      schema: 'o8/cli/receipt.key/v1',
      keyId: keyPayload.keyId,
      publicKey: keyPayload.publicKey,
    });
  }, 30_000);

  it('rejects a receipt after a signed field is tampered with', async () => {
    const keyPayload = requirePublishedKey();
    const original = JSON.parse(readFileSync(receiptPath, 'utf8')) as PacketReceipt;
    writeFileSync(tamperedPath, `${JSON.stringify({ ...original, packetTitle: `${original.packetTitle}!` })}\n`);
    const tampered = await runCli(
      ['verify', tamperedPath, '--key', keyPayload.publicKey, '--repo', repoPath],
      { home: verifierHome, data: verifierDataDir },
    );
    expect(tampered.exitCode).toBe(5);
    expect(JSON.parse(tampered.stdout)).toMatchObject({
      ok: false,
      signatureValid: false,
      errors: [expect.stringContaining('signature is invalid')],
    });
  });

  it('rejects a valid receipt signature from a different trust root', async () => {
    const keyPayload = requirePublishedKey();
    const original = JSON.parse(readFileSync(receiptPath, 'utf8')) as PacketReceipt;
    const otherIdentity = loadOrCreateReceiptIdentityAt(path.join(testHome, 'other-receipt.key'));
    const unsigned = { ...original };
    delete (unsigned as { signature?: string }).signature;
    const wrongKeyUnsigned = { ...unsigned, keyId: otherIdentity.keyId };
    const canonicalBytes = new TextEncoder().encode(canonicalJson(wrongKeyUnsigned));
    const wrongKeyReceipt: PacketReceipt = {
      ...wrongKeyUnsigned,
      signature: signReceiptBytes(canonicalBytes, otherIdentity.secretKey),
    };
    expect(verifyReceiptBytes(
      canonicalBytes,
      wrongKeyReceipt.signature,
      otherIdentity.publicKeyB64,
    )).toBe(true);
    writeFileSync(wrongKeyPath, `${JSON.stringify(wrongKeyReceipt)}\n`);
    const wrongKey = await runCli(
      ['verify', wrongKeyPath, '--key', keyPayload.publicKey],
      { home: verifierHome, data: verifierDataDir },
    );
    expect(wrongKey.exitCode).toBe(5);
    expect(JSON.parse(wrongKey.stdout)).toMatchObject({
      ok: false,
      signatureValid: false,
      keyIdMatches: false,
      errors: [expect.stringContaining('does not match receipt keyId')],
    });
  });
});
