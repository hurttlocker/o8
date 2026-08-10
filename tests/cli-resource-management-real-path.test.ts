import { execFileSync, spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const testHome = mkdtempSync(path.join(os.tmpdir(), 'o8-cli-resources-home-'));
const dataDir = path.join(testHome, '.o8');
const token = 'cli-resource-test-token-0123456789abcdef';
const originalHome = process.env.HOME;
const originalO8DataDir = process.env.O8_DATA_DIR;
const originalCortexDataDir = process.env.CORTEX_IDE_DATA_DIR;
mkdirSync(dataDir, { recursive: true });
writeFileSync(path.join(dataDir, 'ws-token'), `${token}\n`, 'utf8');
process.env.HOME = testHome;
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const reposRoute = await import('@/app/api/panel/repos/route');
const projectsRoute = await import('@/app/api/panel/projects/route');
const projectRoute = await import('@/app/api/panel/projects/[id]/route');
const activeProjectRoute = await import('@/app/api/panel/projects/active/route');

let apiServer: Server | null = null;
let apiPort = 0;
const repoA = mkdtempSync(path.join(os.tmpdir(), 'o8-cli-resource-a-'));
const repoB = mkdtempSync(path.join(os.tmpdir(), 'o8-cli-resource-b-'));
const missionCreateBodies: Array<Record<string, unknown>> = [];
const missionDispatchBodies: Array<Record<string, unknown>> = [];

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function writeRouteResponse(response: ServerResponse, routeResponse: Response): Promise<void> {
  response.writeHead(routeResponse.status, {
    'Content-Type': routeResponse.headers.get('Content-Type') ?? 'application/json',
  });
  response.end(await routeResponse.text());
}

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [path.join(process.cwd(), 'cli/dist/o8.mjs'), ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: testHome,
        O8_DATA_DIR: dataDir,
        CORTEX_IDE_DATA_DIR: dataDir,
        O8_API_PORT: String(apiPort),
        O8_API_TOKEN: token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', (exitCode) => resolveRun({ exitCode, stdout, stderr }));
  });
}

beforeAll(async () => {
  execFileSync('git', ['init', '-q', repoA]);
  execFileSync('git', ['init', '-q', repoB]);
  execFileSync(process.execPath, [path.join(process.cwd(), 'cli/esbuild.config.mjs')], {
    cwd: process.cwd(),
    stdio: 'ignore',
  });

  apiServer = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'wrong bearer' }));
      return;
    }
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const body = await readBody(request);
    const init = {
      method: request.method,
      headers: request.headers as HeadersInit,
      body: body || undefined,
    };

    if (requestUrl.pathname === '/api/orchestrator/create-mission' && request.method === 'POST') {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      missionCreateBodies.push(parsed);
      response.writeHead(201, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        ok: true,
        result: {
          missionId: 'mission-transient-cli',
          packets: [{ id: 'pkt-transient-cli', title: 'Check the repo', wave: 1 }],
        },
      }));
      return;
    }
    if (requestUrl.pathname === '/api/orchestrator/dispatch' && request.method === 'POST') {
      missionDispatchBodies.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result: { initiated: true } }));
      return;
    }

    if (requestUrl.pathname === '/api/panel/repos') {
      const method = request.method as 'GET' | 'POST' | 'DELETE';
      const handler = reposRoute[method];
      if (!handler) throw new Error(`missing repos handler ${method}`);
      await writeRouteResponse(response, await handler(new Request(`http://127.0.0.1${requestUrl.pathname}`, init)));
      return;
    }
    if (requestUrl.pathname === '/api/panel/projects') {
      if (request.method === 'GET') {
        await writeRouteResponse(response, await projectsRoute.GET());
        return;
      }
      if (request.method === 'POST') {
        await writeRouteResponse(response, await projectsRoute.POST(new NextRequest(`http://127.0.0.1${requestUrl.pathname}`, init)));
        return;
      }
    }
    if (requestUrl.pathname === '/api/panel/projects/active' && request.method === 'POST') {
      await writeRouteResponse(response, await activeProjectRoute.POST(new NextRequest(`http://127.0.0.1${requestUrl.pathname}`, init)));
      return;
    }
    const projectMatch = requestUrl.pathname.match(/^\/api\/panel\/projects\/([^/]+)$/);
    if (projectMatch) {
      const id = decodeURIComponent(projectMatch[1]!);
      const context = { params: Promise.resolve({ id }) };
      if (request.method === 'PATCH') {
        await writeRouteResponse(response, await projectRoute.PATCH(new NextRequest(`http://127.0.0.1${requestUrl.pathname}`, init), context));
        return;
      }
      if (request.method === 'DELETE') {
        await writeRouteResponse(response, await projectRoute.DELETE(new NextRequest(`http://127.0.0.1${requestUrl.pathname}`, init), context));
        return;
      }
    }
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: `missing fixture route ${request.method} ${requestUrl.pathname}` }));
  });
  await new Promise<void>((resolveListen) => apiServer!.listen(0, '127.0.0.1', resolveListen));
  const address = apiServer.address();
  if (!address || typeof address === 'string') throw new Error('resource fixture server did not bind');
  apiPort = address.port;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolveClose, reject) => {
    if (!apiServer) return resolveClose();
    apiServer.close((error) => error ? reject(error) : resolveClose());
  });
  rmSync(testHome, { recursive: true, force: true });
  rmSync(repoA, { recursive: true, force: true });
  rmSync(repoB, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalO8DataDir === undefined) delete process.env.O8_DATA_DIR;
  else process.env.O8_DATA_DIR = originalO8DataDir;
  if (originalCortexDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = originalCortexDataDir;
});

describe('o8 repo and project CLI real path', () => {
  it('manages the complete registry and project lifecycle through real routes', async () => {
    const addA = await runCli(['repo', 'add', repoA]);
    expect(addA.exitCode, addA.stderr).toBe(0);
    const repoAResult = JSON.parse(addA.stdout) as { repo: { id: string; path: string } };
    expect(repoAResult).toMatchObject({
      schema: 'o8/cli/repo.add/v1',
      registered: true,
      repo: { path: realpathSync.native(repoA) },
    });

    const addB = await runCli(['repo', 'add', repoB]);
    expect(addB.exitCode, addB.stderr).toBe(0);
    const repoBResult = JSON.parse(addB.stdout) as { repo: { id: string; path: string } };

    const repoList = await runCli(['repo', 'list']);
    expect(repoList.exitCode, repoList.stderr).toBe(0);
    expect(JSON.parse(repoList.stdout)).toMatchObject({
      schema: 'o8/cli/repo.list/v1',
      count: 2,
    });

    const create = await runCli([
      'project',
      'create',
      'Website',
      '--repo',
      repoAResult.repo.id,
      '--repo',
      repoBResult.repo.id,
    ]);
    expect(create.exitCode, create.stderr).toBe(0);
    const created = JSON.parse(create.stdout) as { created: { id: string; repoCount: number } };
    expect(created).toMatchObject({
      schema: 'o8/cli/project.create/v1',
      created: { repoCount: 2 },
    });

    const detach = await runCli(['project', 'remove-repo', created.created.id, repoB]);
    expect(detach.exitCode, detach.stderr).toBe(0);
    expect(JSON.parse(detach.stdout)).toMatchObject({
      schema: 'o8/cli/project.remove-repo/v1',
      project: { repoCount: 1 },
      repoRegistrationPreserved: true,
      localFolderPreserved: true,
    });

    const attach = await runCli(['project', 'add-repo', 'Website', repoBResult.repo.id]);
    expect(attach.exitCode, attach.stderr).toBe(0);
    expect(JSON.parse(attach.stdout)).toMatchObject({
      schema: 'o8/cli/project.add-repo/v1',
      project: { repoCount: 2 },
    });

    const use = await runCli(['project', 'use', 'Website']);
    expect(use.exitCode, use.stderr).toBe(0);
    expect(JSON.parse(use.stdout)).toMatchObject({
      schema: 'o8/cli/project.use/v1',
      activeProjectId: created.created.id,
    });

    const removeProject = await runCli(['project', 'delete', created.created.id]);
    expect(removeProject.exitCode, removeProject.stderr).toBe(0);
    expect(JSON.parse(removeProject.stdout)).toMatchObject({
      schema: 'o8/cli/project.delete/v1',
      removedExclusiveRepoCount: 2,
      localFoldersPreserved: true,
    });
    expect(existsSync(repoA)).toBe(true);
    expect(existsSync(repoB)).toBe(true);

    const afterDelete = await runCli(['repo', 'list']);
    expect(afterDelete.exitCode, afterDelete.stderr).toBe(0);
    expect(JSON.parse(afterDelete.stdout)).toMatchObject({ count: 0, repos: [] });
  }, 30_000);

  it('removes a repo by path and reports that disk was preserved', async () => {
    const add = await runCli(['repo', 'add', repoA]);
    expect(add.exitCode, add.stderr).toBe(0);

    const remove = await runCli(['repo', 'remove', repoA]);
    expect(remove.exitCode, remove.stderr).toBe(0);
    expect(JSON.parse(remove.stdout)).toMatchObject({
      schema: 'o8/cli/repo.remove/v1',
      removedFromRegistry: true,
      localFolderPreserved: true,
      removed: { path: realpathSync.native(repoA) },
    });
    expect(existsSync(repoA)).toBe(true);
  }, 30_000);

  it('refuses to delete the final project with a stable conflict exit', async () => {
    const projects = await runCli(['project', 'list']);
    expect(projects.exitCode, projects.stderr).toBe(0);
    const listed = JSON.parse(projects.stdout) as { projects: Array<{ id: string }> };
    expect(listed.projects).toHaveLength(1);

    const remove = await runCli(['project', 'delete', listed.projects[0]!.id]);
    expect(remove.exitCode).toBe(5);
    expect(JSON.parse(remove.stderr)).toMatchObject({
      schema: 'o8/cli/error/v1',
      error: {
        code: 'last_project',
        ambiguous: false,
      },
    });
  }, 30_000);

  it('spawns from an unregistered repo without adding it to Projects', async () => {
    const before = await runCli(['repo', 'list']);
    expect(JSON.parse(before.stdout)).toMatchObject({ count: 0 });

    const spawnResult = await runCli([
      'worker',
      'spawn',
      '--title',
      'Check the repo',
      '--repo',
      repoA,
      '--caller',
      'outside terminal',
      '--read-only',
    ]);
    expect(spawnResult.exitCode, spawnResult.stderr).toBe(0);
    expect(JSON.parse(spawnResult.stdout)).toMatchObject({
      schema: 'o8/cli/mission.create/v1',
      mission: { missionId: 'mission-transient-cli' },
      dispatch: { initiated: true },
    });
    expect(missionCreateBodies.at(-1)).toMatchObject({
      repoPath: repoA,
      dispatcher: { surface: 'operator', id: 'cli' },
      launchContext: {
        source: 'cli',
        presentation: 'split',
        repoContext: 'transient',
        workMode: 'read-only',
        caller: 'outside terminal',
      },
    });
    expect(missionDispatchBodies.at(-1)).toMatchObject({
      missionId: 'mission-transient-cli',
      wait: false,
    });

    const after = await runCli(['repo', 'list']);
    expect(JSON.parse(after.stdout)).toMatchObject({ count: 0, repos: [] });
  }, 30_000);
});
