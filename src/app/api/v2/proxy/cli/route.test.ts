/**
 * Real-path tests for the CLI chat proxy — driven through the actual POST handler with
 * constructed Requests, because the bug they cover was only reachable that way.
 *
 * Live failure (2026-07-29, o8.run/console over the machine bridge): picking the default
 * "Current project" in a mobile/web chat sends NO repoPath, the route ran the runtime in
 * `process.cwd()`, Codex refused ("Not inside a trusted directory"), and the stream closed
 * with a bare `done` — every surface rendered "No response received." with no reason.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A real `codex exec --json` answer event — the shape normalizeCodex() maps to content. */
const CODEX_ANSWER = { type: 'item.completed', item: { text: 'pong' } };

const spawnCalls: { cmd: string; args: string[]; options: { cwd?: string } }[] = [];

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

let currentChild: FakeChild | null = null;

vi.mock('node:child_process', () => ({
  spawn: (cmd: string, args: string[], options: { cwd?: string }) => {
    spawnCalls.push({ cmd, args, options });
    currentChild = new FakeChild();
    return currentChild;
  },
}));

vi.mock('@/lib/runtimes/shared/cli-resolver', () => ({
  CliNotFoundError: class CliNotFoundError extends Error {
    triedPaths: string[] = [];
  },
  resolveCli: async () => ({ path: '/usr/local/bin/codex', source: 'which', detectedAt: Date.now() }),
}));

function writeRegistry(repos: { name: string; localPath: string; lastOpenedAt?: string }[]) {
  const dataDir = process.env.CORTEX_IDE_DATA_DIR;
  if (!dataDir) throw new Error('test data dir is not pinned');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    path.join(dataDir, 'repos.json'),
    JSON.stringify(repos.map((repo, index) => ({ id: `repo-${index}`, ...repo })), null, 2),
    'utf8',
  );
}

function makeRepoDir(label: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `o8-cli-proxy-${label}-`));
}

function chatRequest(body: Record<string, unknown>): Request {
  return new Request('http://127.0.0.1/api/v2/proxy/cli', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      runtime: 'codex',
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'Reply with just: pong' }],
      ...body,
    }),
  });
}

/** Drive the SSE body to completion after letting the handler attach its listeners. */
async function collectStream(response: Response, drive: (child: FakeChild) => void): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (!currentChild) throw new Error('runtime was never spawned');
  drive(currentChild);
  return await response.text();
}

describe('POST /api/v2/proxy/cli — "Current project" resolution and silent exits', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    currentChild = null;
  });

  it('resolves an absent repoPath to the most recently opened registered repo', async () => {
    const stale = makeRepoDir('stale');
    const current = makeRepoDir('current');
    writeRegistry([
      { name: 'stale', localPath: stale, lastOpenedAt: '2026-07-01T00:00:00.000Z' },
      { name: 'current', localPath: current, lastOpenedAt: '2026-07-29T00:00:00.000Z' },
    ]);

    const { POST } = await import('./route');
    const response = await POST(chatRequest({}));
    expect(response.status).toBe(200);

    await collectStream(response, (child) => {
      child.stdout.emit('data', Buffer.from(`${JSON.stringify(CODEX_ANSWER)}\n`));
      child.emit('close', 0);
    });

    // Pre-fix this was process.cwd() — the repo the operator is actually working in
    // never reached the runtime.
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].options.cwd).toBe(current);
  });

  it('refuses with a stated reason when no repository is registered', async () => {
    writeRegistry([]);

    const { POST } = await import('./route');
    const response = await POST(chatRequest({}));

    // Pre-fix: 200 + a stream that produced nothing.
    expect(response.status).toBe(400);
    const payload = await response.json() as { error?: string; code?: string };
    expect(payload.code).toBe('repo_unavailable');
    expect(payload.error).toMatch(/No repository is registered/i);
    expect(spawnCalls).toHaveLength(0);
  });

  it('explains a runtime that exits without answering instead of closing on a bare done', async () => {
    const repo = makeRepoDir('trusted');
    writeRegistry([{ name: 'repo', localPath: repo, lastOpenedAt: '2026-07-29T00:00:00.000Z' }]);

    const { POST } = await import('./route');
    const response = await POST(chatRequest({ repoPath: repo }));

    const body = await collectStream(response, (child) => {
      child.stderr.emit(
        'data',
        Buffer.from('Not inside a trusted directory and --skip-git-repo-check was not specified.'),
      );
      child.emit('close', 1);
    });

    const events = body
      .split('\n\n')
      .filter((chunk) => chunk.startsWith('data: '))
      .map((chunk) => JSON.parse(chunk.slice('data: '.length)) as Record<string, unknown>);

    const error = events.find((event) => event.type === 'error');
    expect(error, `no error event in stream: ${body}`).toBeTruthy();
    expect(String(error?.message)).toMatch(/exited without a response \(exit code 1\)/);
    expect(String(error?.message)).toMatch(/Not inside a trusted directory/);
    // Consumers split on which field they read; both must carry the reason.
    expect(error?.text).toBe(error?.message);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('stays silent about success — a clean run adds no error event', async () => {
    const repo = makeRepoDir('clean');
    writeRegistry([{ name: 'repo', localPath: repo, lastOpenedAt: '2026-07-29T00:00:00.000Z' }]);

    const { POST } = await import('./route');
    const response = await POST(chatRequest({ repoPath: repo }));

    const body = await collectStream(response, (child) => {
      child.stdout.emit('data', Buffer.from(`${JSON.stringify(CODEX_ANSWER)}\n`));
      child.emit('close', 0);
    });

    expect(body).not.toContain('"type":"error"');
    expect(body).toContain('"type":"done"');
  });
});
