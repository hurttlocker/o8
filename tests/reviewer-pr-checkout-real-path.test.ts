import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { LaunchOptions } from '@/lib/runtimes/types';

// Exercise the clone implementation on Linux; only the filesystem capability probe is replaced.
vi.mock('@/lib/worktree/apfs', async original => ({
  ...await original<typeof import('@/lib/worktree/apfs')>(),
  getApfsCowCapability: async () => ({ macos: true, apfs: true, sameVolume: true, canCowClone: true }),
}));
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({ assertRuntimeDispatchable: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/runtime/capacity-service', () => ({ getRuntimeCapacityControlSnapshot: async () => ({ capacities: [] }) }));
vi.mock('@/lib/codebase-memory/indexer', () => ({ ensureCodebaseMemoryBootIndex: vi.fn() }));
vi.mock('@/lib/cortex/decay', () => ({ ensureDecayBootHook: vi.fn() }));
vi.mock('@/lib/cortex/proposer', () => ({ ensureProposerBootTick: vi.fn() }));
vi.mock('@/lib/cortex/stack-signature', () => ({ ensureStackSignatureBoot: vi.fn() }));
vi.mock('@/lib/cortex/cross-repo-proposer', () => ({ ensureCrossRepoProposerBootTick: vi.fn() }));
vi.mock('@/lib/cortex/external-merge-watcher', () => ({ ensureExternalMergeBootHook: vi.fn() }));
vi.mock('@/lib/runtimes', async (original) => ({
  ...await original<typeof import('@/lib/runtimes')>(),
  getRuntime: () => ({ id: 'claude-code', capabilities: { launch: true }, async launch(options: LaunchOptions) {
    launches.push(options);
    return { ok: true, note: 'fixture reviewer launched', sessionKey: `claude-code-owned:${options.packetId}`, sideEffect: 'none' };
  } }),
}));

const launches: LaunchOptions[] = [];
const tmux = spawnSync('which', ['tmux'], { encoding: 'utf8' }).stdout?.trim();
function quote(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-review-pr-')));
const data = join(root, 'data');
mkdirSync(data);
process.env.O8_DATA_DIR = data;
process.env.CORTEX_IDE_DATA_DIR = data;
process.env.O8_WORKTREE_ROOT = join(root, 'workspaces');
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
const { createCortexDelegationHandlers } = await import('@/lib/mcp/cortex-delegation-handlers');
const { launchRuntimeSurface } = await import('@/lib/runtime/actions');
const { POST } = await import('@/app/api/orchestrator/delegate/route');
const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { getLane } = await import('@/lib/lane/registry');
const { readPinnedLaneCreationBaseCommit } = await import('@/lib/lane/creation-base');
const { addRepo } = await import('@/lib/repos/registry');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { closeDb } = await import('@/lib/db');
const run = promisify(execFile);
const sockets: string[] = [];

afterAll(() => {
  for (const socket of sockets) {
    try { execFileSync(tmux, ['-S', socket, 'kill-server'], { stdio: 'ignore' }); } catch {}
  }
  closeDb();
  rmSync(root, { recursive: true, force: true });
});
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}
async function fixture(label: string) {
  const repo = join(root, label);
  mkdirSync(repo);
  git(repo, 'init', '-qb', 'main');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'user.email', 'test@example.test');
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  const origin = `${repo}.git`;
  git(root, 'clone', '--bare', repo, origin);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'fetch', 'origin', 'main');
  writeFileSync(join(repo, 'pr-only.test.cjs'), "require('node:test')('PR-only check', () => require('node:assert/strict').equal(2 + 2, 4));\n");
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'PR-only test');
  const head = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'push', 'origin', 'HEAD:refs/pull/7/head');
  git(repo, 'reset', '--hard', base);
  // The PR object must be fetched, not accidentally available in the checkout.
  git(repo, 'reflog', 'expire', '--expire=now', '--all');
  git(repo, 'gc', '--prune=now');
  expect(() => git(repo, 'cat-file', '-e', head)).toThrow();
  await addRepo(repo);
  await updateOperatorDefaults({ workerRuntimes: ['claude-code'] });
  return { repo, origin, base, head };
}
function request(repoPath: string, extra: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost/api/orchestrator/delegate', { method: 'POST', body: JSON.stringify({
    clientMutationId: `review-pr-${crypto.randomUUID()}`, repoPath, runtime: 'claude-code',
    taskName: 'Review fixture PR', prompt: 'Review PR 7 and run its test.', readOnly: true,
    reviewPullRequest: 7, ...extra,
  }) });
}

describe('reviewer PR checkout through delegate dispatch', () => {
  it.skipIf(!tmux).each(['git-worktree', 'clone'])('pins the PR head in a %s, runs its test with CLI receipts, and replays the same head', async isolation => {
    process.env.O8_APFS_COW_WORKSPACES = isolation === 'clone' ? '1' : '0';
    const f = await fixture('exact-head-' + isolation);
    const artifacts = join(root, 'artifacts-' + isolation);
    mkdirSync(artifacts);
    const body = { clientMutationId: 'review-pr-exact-head-' + isolation };
    const response = await POST(request(f.repo, body));
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200);
    const launched = launches.at(-1)!;
    expect(launched.workMode).toBe('read-only');
    expect(git(launched.cwd!, 'rev-parse', 'HEAD')).toBe(f.head);
    expect(readPinnedLaneCreationBaseCommit(result.laneId)).toBe(f.head);
    expect(git(launched.cwd!, 'diff', 'main...HEAD', '--name-only')).toContain('pr-only.test.cjs');
    expect(readOrchestratorControlPlaneState().packets.find(p => p.id === result.packetId))
      .toMatchObject({ reviewSource: { pullRequest: 7, headSha: f.head } });
    expect(getLane(result.laneId)?.worktreePath).toBe(launched.cwd);
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(f.base);
    expect(existsSync(join(f.repo, 'pr-only.test.cjs'))).toBe(false);

    const bundle = join(artifacts, 'o8.mjs');
    await build({ entryPoints: ['cli/src/index.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22',
      define: { __O8_CLI_VERSION__: JSON.stringify('test') }, banner: { js: "import { createRequire as __fixtureRequire } from 'node:module'; const require = __fixtureRequire(import.meta.url);" } });
    const bin = join(artifacts, 'bin');
    mkdirSync(bin);
    const socket = join(root, isolation + '.sock');
    sockets.push(socket);
    writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nexec ${quote(tmux)} -S ${quote(socket)} "$@"\n`, { mode: 0o700 });
    chmodSync(join(bin, 'tmux'), 0o700);
    execFileSync(tmux, ['-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'keepalive', 'sleep 90']);
    const registrations: unknown[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const payload = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      if (payload.action === 'register') registrations.push(payload);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url?.startsWith('/api/lanes')
        ? { lanes: [{ id: result.laneId, packetId: result.packetId, worktreePath: launched.cwd }] } : { ok: true }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing fixture port');
      const temp = join(artifacts, 'tmp');
      mkdirSync(temp);
      const marker = '1792655458237-1234abcd';
      const checked = await run(process.execPath, [bundle, 'run', '--', process.execPath, '--test', 'pr-only.test.cjs'], {
        cwd: launched.cwd, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: temp,
          O8_OWNED_RUN_MARKER: marker, O8_WORKER_PACKET_ID: result.packetId, O8_WORKER_TOKEN: 'fixture',
          O8_API_PORT: String(address.port), O8_API_TOKEN: '', NODE_OPTIONS: '' }, timeout: 20_000,
      });
      expect(checked.stdout).toContain('PR-only check');
      const directory = join(temp, 'o8-worker-runs', marker, 'logs', 'run');
      const metadata = readdirSync(directory).find(name => name.endsWith('.json'))!;
      const receipt = JSON.parse(readFileSync(join(directory, metadata), 'utf8'));
      expect(readFileSync(join(directory, `${receipt.id}.exit`), 'utf8')).toBe('0');
      expect(readFileSync(join(directory, `${receipt.id}.log`), 'utf8')).toContain('PR-only check');
      expect(registrations).toEqual([expect.objectContaining({ packetId: result.packetId, laneId: result.laneId })]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    const count = launches.length;
    git(f.origin, 'update-ref', 'refs/pull/7/head', f.base);
    expect(await (await POST(request(f.repo, body))).json()).toMatchObject({ replayed: true, packetId: result.packetId });
    expect(launches).toHaveLength(count);
    expect(git(launched.cwd!, 'rev-parse', 'HEAD')).toBe(f.head);
    expect((await POST(request(f.repo, { ...body, reviewPullRequest: 8 }))).status).toBe(409);
    // A relaunch or fallback must refuse a stale/replaced checkout before the runtime sees it.
    await expect(launchRuntimeSurface({ runtime: 'claude-code', packetId: result.packetId,
      repoPath: f.repo, prompt: 'Review the pinned PR', isolate: false, skipSetup: true }))
      .rejects.toThrow('Reviewer checkout does not match its pinned PR head');
    expect(launches).toHaveLength(count);
  }, 90_000);

  it('forwards the explicit PR target through the agent tool to persisted dispatch', async () => {
    process.env.O8_APFS_COW_WORKSPACES = '0';
    const f = await fixture('mcp-entry');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).endsWith('/api/orchestrator/delegate')) return POST(new NextRequest(String(input), { ...init, signal: init?.signal ?? undefined }));
      return Response.json({ ok: true });
    });
    try {
      const handlers = createCortexDelegationHandlers({ apiFetch: async () => ({}), apiBase: 'http://localhost',
        repoPath: f.repo, parentThreadId: '', fastCapability: '', wsToken: 'fixture' });
      const response = await handlers.handleLaunchAgent({ prompt: 'Review PR 7', runtime: 'claude-code',
        readOnly: true, reviewPullRequest: 7 });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      const result = JSON.parse(response.content[0].text);
      expect(result.ok).toBe(true);
      expect(result.reviewSource).toEqual({ pullRequest: 7, headSha: f.head });
      expect(git(result.worktreePath, 'rev-parse', 'HEAD')).toBe(f.head);
      const packet = readOrchestratorControlPlaneState().packets.find(p => p.id === getLane(result.laneId)?.packetId);
      expect(packet).toMatchObject({ reviewSource: { pullRequest: 7, headSha: f.head } });
    } finally { fetchSpy.mockRestore(); }
  });

  it.each([0, -1, '7', 1.5])('refuses malformed PR number %s before creating a packet', async number => {
    const count = readOrchestratorControlPlaneState().packets.length;
    const response = await POST(request(root, { reviewPullRequest: number }));
    expect(response.status).toBe(400);
    expect(readOrchestratorControlPlaneState().packets).toHaveLength(count);
  });

  it('refuses a PR target in editable or shared mode', async () => {
    for (const extra of [{ readOnly: false }, { checkoutMode: 'shared' }]) {
      expect((await POST(request(root, extra))).status).toBe(400);
    }
  });

  it('refuses a missing PR ref without launching on the base', async () => {
    const f = await fixture('missing-ref');
    const count = launches.length;
    const packets = readOrchestratorControlPlaneState().packets.length;
    const response = await POST(request(f.repo, { reviewPullRequest: 404 }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ ok: false, code: 'review_source_unavailable' });
    expect(launches).toHaveLength(count);
    expect(readOrchestratorControlPlaneState().packets).toHaveLength(packets);
  });
});
