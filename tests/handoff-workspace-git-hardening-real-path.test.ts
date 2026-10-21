import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { HandoffPacket } from '@/lib/orchestrator/handoff-packet';

const root = mkdtempSync(join(tmpdir(), 'o8-handoff-git-'));
process.env.O8_DATA_DIR = join(root, 'data');
process.env.CORTEX_IDE_DATA_DIR = process.env.O8_DATA_DIR;
const history = await import('@/lib/mobile/orchestrator-thread-history');
const store = await import('@/lib/llm/chat-history-store');
const registry = await import('@/lib/lane/registry');
const handoff = await import('@/lib/orchestrator/handoff-packet');
const facts = await import('@/lib/lane/lane-diff-facts');
const creation = await import('@/lib/lane/creation-base');
const { closeDb } = await import('@/lib/db');

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function persist(packet: HandoffPacket) {
  history.appendMobileOrchestratorUserMessage({ tabId: packet.threadId, repoPath: packet.workspace!.worktreePath,
    message: 'Continue from measured source.', backend: 'codex', handoff: {
      handoffId: packet.handoffId, from: null, to: packet.to, lossless: false,
      carries: packet.carries, packet: packet as unknown as Record<string, unknown>,
    } });
  const saved = store.readPersistedLlmChat(packet.threadId)?.history.messages
    .find(message => message.id === packet.handoffId)?.handoff?.packet;
  expect(saved).toEqual(packet);
  return saved as unknown as HandoffPacket;
}
async function fixture() {
  const directory = mkdtempSync(join(root, 'fixture-'));
  const repo = join(directory, 'repo'); const worktree = join(directory, 'worktree');
  const markers = join(directory, 'markers'); mkdirSync(repo); mkdirSync(markers);
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Test Author');
  git(repo, 'config', 'user.email', 'test@example.test');
  writeFileSync(join(repo, 'source.txt'), 'base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  git(repo, 'worktree', 'add', '-b', 'handoff', worktree);
  git(repo, 'config', 'extensions.worktreeConfig', 'true');
  writeFileSync(join(worktree, 'source.txt'), 'working source\n');
  const lane = registry.createLane({ repoPath: repo, worktreePath: worktree, branch: 'handoff',
    baseBranch: 'main', runtime: 'codex', projectId: null });
  const threadId = history.createMobileOrchestratorThread({ repoPath: worktree, backend: 'o8' }).id;
  history.appendMobileOrchestratorUserMessage({ tabId: threadId, repoPath: worktree,
    message: 'Continue the source evidence.', backend: 'o8' });
  history.upsertMobileOrchestratorAssistantMessage({ tabId: threadId, messageId: `${threadId}-assistant`,
    content: 'The worktree has been measured.', repoPath: worktree, backend: 'o8' });
  const input = { threadId, laneId: lane.id, to: { backend: 'codex', model: null } };
  const original = persist(await handoff.buildHandoffPacket(input));
  expect(original.workspace?.evidence).not.toBeNull();
  const index = git(worktree, 'rev-parse', '--absolute-git-dir');
  const indexBefore = readFileSync(join(index, 'index'));
  const plant = () => {
    const script = join(directory, 'hostile.sh');
    writeFileSync(script, `#!/bin/sh\n: > "${join(markers, 'executed')}"\nexit 0\n`, { mode: 0o755 });
    for (const key of ['core.fsmonitor', 'filter.hostile.clean', 'diff.external', 'diff.hostile.textconv']) {
      git(worktree, 'config', '--worktree', key, script);
    }
    writeFileSync(join(worktree, '.gitattributes'), 'source.txt filter=hostile diff=hostile\n');
  };
  return { repo, worktree, markers, lane, input, original, index, indexBefore, plant };
}
afterAll(() => { closeDb(); rmSync(root, { recursive: true, force: true }); });

describe('handoff capture and inspection through hardened Git', () => {
  it.each([true, false])('captures a hostile worktree without executing programs (lane %s)', async withLane => {
    const f = await fixture(); f.plant();
    const captured = await handoff.buildHandoffPacket(withLane ? f.input : { ...f.input, laneId: undefined });
    expect(captured.workspace).toMatchObject({ branch: 'handoff', dirty: true,
      touchedFiles: expect.arrayContaining(['source.txt', '.gitattributes']) });
    if (withLane) {
      expect(captured.workspace?.evidence).not.toBeNull();
      expect(await handoff.inspectHandoffWorkspaceFreshness(persist(captured))).toMatchObject({ status: 'fresh' });
      const pinnedCreationBaseCommit = creation.readLaneCreationBaseCommit(f.lane.id)!;
      expect((await facts.getLaneSpokenDiffFacts(f.lane, { pinnedCreationBaseCommit })).dirtyFiles).toContain('source.txt');
      expect(await handoff.inspectHandoffWorkspaceFreshness(f.original)).toMatchObject({
        status: 'stale', reason: 'snapshot-changed',
      });
    } else expect(captured.workspace?.evidence).toBeNull();
    expect(readdirSync(f.markers)).toEqual([]);
    expect(readFileSync(join(f.index, 'index'))).toEqual(f.indexBefore);
  });

  it('returns no workspace for redirected linked metadata and refuses persisted inspection', async () => {
    const f = await fixture(); f.plant();
    writeFileSync(join(f.worktree, '.git'), `gitdir: ${join(f.repo, '.git')}\n`);
    expect((await handoff.buildHandoffPacket(f.input)).workspace).toBeNull();
    expect((await handoff.buildHandoffPacket({ ...f.input, laneId: undefined })).workspace).toBeNull();
    expect(await handoff.inspectHandoffWorkspaceFreshness(f.original)).toMatchObject({
      status: 'unavailable', reason: 'evidence-unavailable',
    });
    expect(readdirSync(f.markers)).toEqual([]);
  });
});
