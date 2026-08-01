import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const cliEntrypoint = join(root, 'cli/dist/o8.mjs');
const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-harness-cli-data-'));
const token = 'harness-cli-test-token-0123456789abcdef';
writeFileSync(join(dataDir, 'ws-token'), `${token}\n`);
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const harnessRoute = await import('@/app/api/harness/route');
const { closeDb } = await import('@/lib/db');

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(port: number, args: string[], cwd = root): Promise<CliResult> {
  return new Promise((resolveResult) => {
    execFile(process.execPath, [cliEntrypoint, ...args], {
      cwd,
      timeout: 20_000,
      env: {
        ...process.env,
        O8_API_PORT: String(port),
        O8_API_TOKEN: token,
        O8_WORKER_TOKEN: '',
        O8_WORKER_PACKET_ID: '',
      },
    }, (error, stdout, stderr) => {
      resolveResult({
        code: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
        stdout,
        stderr,
      });
    });
  });
}

async function withHarnessServer(
  run: (port: number, requests: Array<Record<string, unknown>>) => Promise<void>,
): Promise<void> {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', async () => {
      try {
        const body = JSON.parse(raw) as Record<string, unknown>;
        requests.push(body);
        const routeResponse = await harnessRoute.POST(new NextRequest('http://localhost:3001/api/harness', {
          method: 'POST',
          headers: {
            host: 'localhost:3001',
            authorization: request.headers.authorization ?? '',
            'content-type': 'application/json',
          },
          body: raw,
        }));
        response.writeHead(routeResponse.status, { 'content-type': 'application/json' });
        response.end(await routeResponse.text());
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: { message: String(error) } }));
      }
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    await run((server.address() as AddressInfo).port, requests);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    }));
  }
}

describe.sequential('harness CLI real path', () => {
  beforeAll(() => {
    execFileSync(process.execPath, [join(root, 'cli/esbuild.config.mjs')], { cwd: root });
  });

  afterAll(() => {
    closeDb();
  });

  it('persists a feature through the bundled public CLI and real HTTP route', async () => {
    const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-harness-cli-repo-'));
    await withHarnessServer(async (port, requests) => {
      const added = await runCli(port, [
        'feature', 'add', '--repo', repoPath, '--title', 'CLI real path', '--description', 'Persist this feature.',
      ]);
      expect(added.code, added.stderr).toBe(0);
      const feature = JSON.parse(added.stdout) as { id: string; repoPath: string; status: string };
      expect(feature).toMatchObject({ repoPath: realpathSync(repoPath), status: 'failing' });

      const next = await runCli(port, ['feature', 'next', '--repo', repoPath]);
      expect(next.code, next.stderr).toBe(0);
      expect(JSON.parse(next.stdout)).toMatchObject({
        schema: 'o8/feature-next/v1',
        repoPath: realpathSync(repoPath),
        feature: { id: feature.id, title: 'CLI real path' },
      });

      const capabilities = await runCli(port, ['capabilities', '--model', 'test-model']);
      expect(capabilities.code, capabilities.stderr).toBe(0);
      expect(JSON.parse(capabilities.stdout)).toMatchObject({
        schema: 'o8/harness-capabilities/v1',
        version: 1,
      });
      expect(requests.map((request) => request.action)).toEqual(['feature_add', 'feature_next', 'capabilities']);
    });
  });

  it('executes o8/ci/v1 and leaves persisted passing evidence through the route', async () => {
    const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-harness-ci-repo-'));
    const configPath = join(repoPath, 'o8.ci.json');
    await withHarnessServer(async (port, requests) => {
      const added = await runCli(port, ['feature', 'add', '--repo', repoPath, '--title', 'CI evidence']);
      expect(added.code, added.stderr).toBe(0);
      const feature = JSON.parse(added.stdout) as { id: string };
      writeFileSync(configPath, JSON.stringify({
        schema: 'o8/ci/v1',
        repoPath: '.',
        checks: [{
          name: 'node check',
          command: [process.execPath, '-e', "process.stdout.write('check passed')"],
          featureId: feature.id,
        }],
      }));

      const ci = await runCli(port, ['ci', '--config', configPath], repoPath);
      expect(ci.code, ci.stderr).toBe(0);
      expect(JSON.parse(ci.stdout)).toMatchObject({
        schema: 'o8/cli/ci/v1',
        passed: true,
        checks: [{ name: 'node check', status: 'passed', featureId: feature.id }],
      });

      const listed = await runCli(port, ['feature', 'list', '--repo', repoPath, '--passing']);
      expect(listed.code, listed.stderr).toBe(0);
      expect(JSON.parse(listed.stdout)).toMatchObject({
        features: [{
          id: feature.id,
          status: 'passing',
          latestCheck: { status: 'passed', evidence: 'check passed', exitCode: 0 },
        }],
      });
      expect(requests.map((request) => request.action)).toEqual(['feature_add', 'verify', 'feature_list']);
    });
  });
});
