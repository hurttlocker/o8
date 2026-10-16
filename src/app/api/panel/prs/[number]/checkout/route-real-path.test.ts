import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ repo: vi.fn(), head: vi.fn(), git: vi.fn(), manager: vi.fn(), create: vi.fn() }));
vi.mock('@/lib/repos/registry', () => ({ findRepoByLocalPath: mocks.repo }));
vi.mock('@/lib/github-broker/actions', () => ({ getGitHubPullRequestHeadRef: mocks.head }));
vi.mock('@/lib/mcp/task-draft-git', () => ({ taskDraftGit: mocks.git }));
vi.mock('@/lib/worktree/launch', () => ({ getWorktreeManager: mocks.manager }));

const root = mkdtempSync(path.join(os.tmpdir(), 'o8-pr-checkout-unavailable-'));
const marker = path.join(root, 'git-called');
const gitGuard = path.join(root, 'git');
writeFileSync(gitGuard, `#!/bin/sh\nprintf git-called > '${marker}'\nexit 97\n`);
chmodSync(gitGuard, 0o700);
// Prove the command guard observes execution before using it around requests.
try { execFileSync(gitGuard, [], { stdio: 'ignore' }); } catch { /* Expected guard refusal. */ }
if (readFileSync(marker, 'utf8') !== 'git-called') throw new Error('Git command guard was not armed.');
unlinkSync(marker);
const originalPath = process.env.PATH;
const { POST } = await import('./route');
const sha = 'a'.repeat(40);
const body = { repo: 'example/repo', repoPath: root, commitSha: sha };
function request(payload: string, host = '127.0.0.1') {
  const req = new NextRequest(`http://${host}/api/panel/prs/7/checkout`, { method: 'POST', headers: { host, 'Content-Type': 'application/json' }, body: payload });
  const json = vi.spyOn(req, 'json');
  const then = vi.fn(() => { throw new Error('Deferred creation must not resolve request parameters.'); });
  const params = { then } as unknown as Promise<{ number: string }>;
  return { response: POST(req, { params }), json, then };
}
function expectNoCreation() {
  for (const spy of Object.values(mocks)) expect(spy).not.toHaveBeenCalled();
  expect(existsSync(marker)).toBe(false);
}
beforeEach(() => {
  vi.clearAllMocks();
  process.env.PATH = `${root}${path.delimiter}${originalPath || ''}`;
  mocks.manager.mockReturnValue({ create: mocks.create });
});
afterEach(() => { if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; vi.restoreAllMocks(); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('deferred PR review workspace entry point', () => {
  it.each([JSON.stringify(body), '{'])('refuses authenticated creation before reading the body, resolving parameters or accessing Git: %s', async (payload) => {
    const { response, json, then } = request(payload);
    const result = await response;
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: 'Creating a review workspace is temporarily unavailable.', code: 'review_workspace_unavailable' });
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(json).not.toHaveBeenCalled(); expect(then).not.toHaveBeenCalled(); expectNoCreation();
  });
  it('keeps the real authentication gate ahead of the unavailable response and all creation access', async () => {
    const { response, json, then } = request(JSON.stringify(body), 'remote.test');
    const result = await response;
    expect(result.status).toBe(401); expect(await result.json()).toEqual({ error: 'Unauthorized' });
    expect(json).not.toHaveBeenCalled(); expect(then).not.toHaveBeenCalled(); expectNoCreation();
  });
});
