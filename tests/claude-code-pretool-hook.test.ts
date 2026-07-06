import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const hookPath = path.resolve(process.cwd(), 'dist/hooks/claude-code-pretool-hook.js');
let server: ReturnType<typeof createServer> | null = null;

function hookInput(command: string) {
  return JSON.stringify({
    session_id: 'session-1',
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: 'tool-1',
  });
}

function runHook(command: string, port: number) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [hookPath], {
      env: {
        ...process.env,
        O8_MANAGED_SESSION: '1',
        O8_API_HOST: '127.0.0.1',
        O8_API_PORT: String(port),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(hookInput(command));
  });
}

function readBody(req: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function withApprovalServer<T>(callback: (port: number) => T | Promise<T>) {
  const requests: string[] = [];
  server = createServer(async (req, res) => {
    requests.push(await readBody(req));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => {
    server?.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  try {
    const result = await callback(port);
    return { result, requests };
  } finally {
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
    server = null;
  }
}

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve) => {
    server?.close(() => resolve());
  });
  server = null;
});

describe('claude-code pretool hook approval rows', () => {
  it('keeps managed ask_user on stdout without creating an approval row', async () => {
    const { result, requests } = await withApprovalServer((port) => runHook('git merge feature-branch', port));
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim()) as { decision: string; hookSpecificOutput: { permissionDecision: string } };
    expect(payload.decision).toBe('ask_user');
    expect(payload.hookSpecificOutput.permissionDecision).toBe('ask');
    expect(requests).toHaveLength(0);
  });

  it('keeps managed block rows in the approval audit trail', async () => {
    const { result, requests } = await withApprovalServer((port) => runHook('rm -rf important-dir', port));
    expect(result.status).toBe(2);
    const payload = JSON.parse(result.stdout.trim()) as { decision: string; hookSpecificOutput: { permissionDecision: string } };
    expect(payload.decision).toBe('block');
    expect(payload.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0])).toMatchObject({
      action: 'create',
      approval: {
        source: 'runtime',
        runtime: 'claude-code',
        title: 'Blocked Claude Code tool use',
      },
    });
  });
});
