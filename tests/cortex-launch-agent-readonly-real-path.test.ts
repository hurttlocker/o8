import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fake API did not bind a TCP port.');
  return address.port;
}

function callLaunchAgent(child: ChildProcessWithoutNullStreams) {
  return new Promise<void>((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => reject(new Error('Timed out waiting for cortex_launch_agent.')), 10_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf('\n');
        if (newline < 0) break;
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line.startsWith('{')) continue;
        const response = JSON.parse(line) as { id?: number };
        if (response.id === 1) {
          clearTimeout(timer);
          resolve();
        }
      }
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'cortex_launch_agent',
        arguments: {
          prompt: 'Inspect package.json and report its version.',
          repoPath: '/tmp/o8-readonly-fixture',
          taskName: 'Report package version',
          runtime: 'codex',
          readOnly: true,
        },
      },
    })}\n`);
  });
}

describe('cortex_launch_agent read-only contract', () => {
  it('forwards readOnly through the real MCP entry to the governed delegate route', { timeout: 20_000 }, async () => {
    const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-cortex-readonly-'));
    let captured: Record<string, unknown> | null = null;
    const server = createServer((request, response) => {
      if (request.method !== 'POST' || request.url !== '/api/orchestrator/delegate') {
        response.writeHead(404);
        response.end();
        return;
      }
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { raw += chunk; });
      request.on('end', () => {
        captured = JSON.parse(raw) as Record<string, unknown>;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: 'fixture stopped after contract capture' }));
      });
    });
    const port = await listen(server);
    const child = spawn('npx', ['tsx', 'src/lib/mcp/cortex-mcp-server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CORTEX_API_BASE: `http://127.0.0.1:${port}`,
        CORTEX_IDE_DATA_DIR: dataDir,
        O8_DATA_DIR: dataDir,
        O8_MCP_NODE22_CHECKED: '1',
        WS_TOKEN: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    try {
      await callLaunchAgent(child);
      expect(captured).toMatchObject({
        prompt: 'Inspect package.json and report its version.',
        repoPath: '/tmp/o8-readonly-fixture',
        taskName: 'Report package version',
        runtime: 'codex',
        readOnly: true,
        clientMutationId: expect.any(String),
      });
    } finally {
      child.stdin.end();
      await Promise.race([
        once(child, 'exit'),
        new Promise<void>((resolve) => setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 2_000)),
      ]);
      server.close();
      await once(server, 'close');
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
