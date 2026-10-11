import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { GET, POST } from '@/app/api/panel/terminal-state/route';
import { computeRestoredTabs, loadInitialTabState } from '@/components/desktop/workspace-terminal/terminal-restore';
import { laneGitArguments, laneGitEnvironment, laneGitSync } from '@/lib/lane/lane-git';
import * as laneGit from '@/lib/lane/lane-git';
import { listReposFresh } from '@/lib/repos/registry';
import { buildRepoStateScope, MAX_PERSISTED_TABS } from '@/lib/terminal/tab-state';
import { includeRegisteredWorktreeRoots } from '@/lib/terminal/registered-worktree-roots';

const dataDir = process.env.CORTEX_IDE_DATA_DIR!;
const stateUrl = 'http://localhost/api/panel/terminal-state?scope=tile-root';
let fixture: string;
let registered: string;
let worktree: string;
let standalone: string;
let forged: string;
let escaped: string;
let preferred: string;

function initializeRepo(repo: string) {
  mkdirSync(repo);
  execFileSync('git', laneGitArguments(['init', '-q', '-b', 'main']), { cwd: repo, env: laneGitEnvironment(true) });
  writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
  laneGitSync(repo, repo, ['add', 'seed.txt']);
  laneGitSync(repo, repo, ['commit', '-q', '-m', 'seed'], { identity: { name: 'Fixture', email: 'fixture@example.test' } });
}

beforeAll(() => {
  fixture = realpathSync(mkdtempSync(path.join(dataDir, 'restore-worktree-')));
  registered = path.join(fixture, 'registered');
  worktree = path.join(fixture, 'external-worktree');
  standalone = path.join(fixture, 'unregistered');
  forged = path.join(fixture, 'forged');
  preferred = path.join(fixture, 'preferred');
  initializeRepo(registered);
  initializeRepo(standalone);
  laneGitSync(registered, registered, ['worktree', 'add', '--detach', worktree]);
  mkdirSync(forged);
  mkdirSync(preferred);
  writeFileSync(path.join(forged, '.git'), readFileSync(path.join(worktree, '.git')));
  escaped = path.join(registered, 'escape');
  symlinkSync(standalone, escaped, 'junction');
});

beforeEach(async () => {
  rmSync(path.join(dataDir, 'terminal-states'), { recursive: true, force: true });
  rmSync(path.join(dataDir, 'terminal-state.json'), { force: true });
  writeFileSync(path.join(dataDir, 'repos.json'), JSON.stringify({ version: 1, repos: [
    { id: 'registered', name: 'Registered', localPath: registered },
    { id: 'preferred', name: 'Preferred', localPath: preferred },
  ] }));
  await listReposFresh();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(() => rmSync(fixture, { recursive: true, force: true }));

it('restores the selected external Git worktree conversation through the API and initial restore despite another preferred repo', async () => {
  const selected = { version: 1, activeTabId: 'orchestrator-selected', savedAt: '2026-10-11T12:00:00.000Z', tabs: [
    { id: 'orchestrator-selected', kind: 'orchestrator', label: 'Selected', repoPath: worktree, orchestratorThreadId: 'thoughts-selected' },
  ] };
  await POST(new Request(stateUrl.replace('tile-root', buildRepoStateScope(preferred)), { method: 'POST', body: JSON.stringify({
    version: 1, activeTabId: 'orchestrator-old', savedAt: '2026-10-10T12:00:00.000Z', tabs: [
      { id: 'orchestrator-old', kind: 'orchestrator', label: 'Old', repoPath: preferred, orchestratorThreadId: 'thoughts-old' },
    ],
  }) }));
  await POST(new Request(stateUrl, { method: 'POST', body: JSON.stringify(selected) }));
  const response = await GET(new Request(stateUrl));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(selected);
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => GET(new Request(new URL(String(input), 'http://localhost')))));
  const saved = await loadInitialTabState({ stateScope: 'tile-root', defaultTab: 'orchestrator', splitCreated: false, preferredRepoPath: preferred }, () => false);
  const restored = await computeRestoredTabs(saved!, { preferredRepo: { name: 'Preferred', localPath: preferred }, defaultTab: 'orchestrator', createDefaultChatTab: () => { throw new Error('The selected thread must restore'); } }, undefined, 'optimistic');
  expect(restored?.activeTabId).toBe(selected.activeTabId);
  expect(restored?.tabs[0]).toMatchObject({ repo: { localPath: worktree }, orchestratorThreadId: 'thoughts-selected' });
});

it.each(['standalone', 'forged', 'escaped'])('rejects an unregistered %s path through persisted state and explicit repo requests', async (kind) => {
  const repoPath = kind === 'standalone' ? standalone : kind === 'forged' ? forged : escaped;
  await POST(new Request(stateUrl, { method: 'POST', body: JSON.stringify({ version: 1, activeTabId: 'orchestrator-untrusted', savedAt: '2026-10-11T12:00:00.000Z', tabs: [
    { id: 'orchestrator-untrusted', kind: 'orchestrator', label: 'Unknown', repoPath, orchestratorThreadId: 'thoughts-untrusted' },
  ] }) }));
  expect((await GET(new Request(stateUrl))).status).toBe(204);
  expect((await GET(new Request(`${stateUrl}&repoPath=${encodeURIComponent(repoPath)}`))).status).toBe(204);
});

it('prioritizes the selected worktree when an older snapshot exceeds the persisted-tab cap', async () => {
  const tabs = Array.from({ length: MAX_PERSISTED_TABS + 1 }, (_, index) => ({
    id: `orchestrator-${index}`, kind: 'orchestrator', repoPath: preferred,
  }));
  await POST(new Request(stateUrl, { method: 'POST', body: JSON.stringify({ version: 1, activeTabId: 'orchestrator-selected', tabs: [
    ...tabs, { id: 'orchestrator-selected', kind: 'orchestrator', repoPath: worktree, orchestratorThreadId: 'thoughts-selected' },
  ] }) }));
  const response = await GET(new Request(stateUrl));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ activeTabId: 'orchestrator-selected', tabs: expect.arrayContaining([
    expect.objectContaining({ id: 'orchestrator-selected', repoPath: worktree, orchestratorThreadId: 'thoughts-selected' }),
  ]) });
});

it('bounds Git candidate verification even for oversized input', () => {
  const invocation = vi.spyOn(laneGit, 'laneGitInvocation').mockImplementation((candidate) => {
    if (candidate !== registered) throw new Error('Not registered');
    return { args: [], env: { NODE_ENV: 'test' as const, GIT_COMMON_DIR: '/fixture/common' }, cwd: registered };
  });
  const candidates = Array.from({ length: MAX_PERSISTED_TABS * 2 }, (_, index) => path.join(fixture, `unknown-${index}`));
  expect(includeRegisteredWorktreeRoots(new Set([registered]), candidates)).toEqual(new Set([registered]));
  expect(invocation).toHaveBeenCalledTimes(MAX_PERSISTED_TABS + 1);
});

it.each([null, [], 'not a snapshot', { tabs: {} }])('rejects malformed persisted top-level state before probing Git: %j', async (state) => {
  const invocation = vi.spyOn(laneGit, 'laneGitInvocation');
  await POST(new Request(stateUrl, { method: 'POST', body: JSON.stringify(state) }));
  expect((await GET(new Request(`${stateUrl}&repoPath=${encodeURIComponent(worktree)}`))).status).toBe(204);
  expect(invocation).not.toHaveBeenCalled();
});
