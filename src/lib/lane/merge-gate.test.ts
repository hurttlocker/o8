import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { scanRepo } from '@/lib/skeleton';
import { runMergeGate } from './merge-gate';
import type { Lane } from './types';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo(): string {
  const repoPath = mkdtempSync(join(tmpdir(), 'o8-merge-gate-repo-'));
  git(repoPath, ['init', '-q', '-b', 'main']);
  git(repoPath, ['config', 'user.email', 'test@o8.dev']);
  git(repoPath, ['config', 'user.name', 'o8 test']);
  writeFileSync(join(repoPath, 'safe.ts'), [
    'export function first() { return 1; }',
    'export function second() { return 2; }',
    'export function third() { return 3; }',
    'export function fourth() { return 4; }',
    'export function fifth() { return 5; }',
    'export function sixth() { return 6; }',
    'export function seventh() { return 7; }',
    'export function eighth() { return 8; }',
    'export function ninth() { return 9; }',
    'export function tenth() { return 10; }',
    '',
  ].join('\n'));
  git(repoPath, ['add', 'safe.ts']);
  git(repoPath, ['commit', '-q', '-m', 'base']);
  return repoPath;
}

function laneFixture(repoPath: string): Lane {
  return {
    id: 'lane-merge-gate-test',
    projectId: null,
    label: 'merge gate test',
    repoPath,
    worktreePath: repoPath,
    branch: 'feature/merge-gate-test',
    baseBranch: 'main',
    runtime: 'codex',
    sessionKey: 'codex:merge-gate-test',
    packetId: 'pkt-merge-gate-test',
    prNumber: null,
    status: 'reviewing',
    ownership: 'managed',
    writerToken: null,
    lastHeartbeatAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastEventAt: null,
    lastEventLabel: null,
  };
}

describe('merge gate governance invariants', () => {
  it('downgrades approved budget overruns while keeping security blocks hard-blocking', async () => {
    const repoPath = initRepo();
    await scanRepo({ repoPath, chunks: false });
    git(repoPath, ['checkout', '-q', '-b', 'feature/merge-gate-test']);
    writeFileSync(join(repoPath, 'safe.ts'), [
      'export function first() { return 1; }',
      'export function second() { return 2; }',
      'export function third() { return 3; }',
      'export function fourth() { return 4; }',
      'export function fifth() { return 5; }',
      'export function sixth() { return 6; }',
      'export function seventh() { return 7; }',
      'export function eighth() { return 8; }',
      'export function ninth() { return 9; }',
      'export function tenth() { return 10; }',
      'export const extra1 = 1;',
      'export const extra2 = 2;',
      'export const extra3 = 3;',
      'export const extra4 = 4;',
      'export const extra5 = 5;',
      'export const extra6 = 6;',
      'export const extra7 = 7;',
      'export const injected = eval("2 + 2");',
      '',
    ].join('\n'));
    git(repoPath, ['add', 'safe.ts']);
    git(repoPath, ['commit', '-q', '-m', 'feat: risky diff']);

    const result = runMergeGate(laneFixture(repoPath), undefined, true);

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'budget',
        severity: 'warn',
        label: 'Add budget exceeded',
        file: 'safe.ts',
      }),
      expect.objectContaining({
        category: 'security',
        severity: 'block',
        label: 'eval() — code injection risk',
        file: 'safe.ts',
      }),
    ]));
  }, 20_000);

  it('adds an integrity block when self-review claims passed:true despite blocking violations', () => {
    const repoPath = initRepo();
    git(repoPath, ['checkout', '-q', '-b', 'feature/merge-gate-test']);
    writeFileSync(join(repoPath, 'safe.ts'), [
      'export function first() { return 1; }',
      'export const injected = eval("2 + 2");',
      '',
    ].join('\n'));
    git(repoPath, ['add', 'safe.ts']);
    git(repoPath, ['commit', '-q', '-m', 'feat: unsafe self review']);

    const result = runMergeGate(laneFixture(repoPath), {
      passed: true,
      confidence: 'high',
      summary: 'looks good',
      issuesFound: [],
    }, false);

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'security',
        severity: 'block',
      }),
      expect.objectContaining({
        category: 'integrity',
        severity: 'block',
        label: 'Self-review integrity failure',
      }),
    ]));
  }, 20_000);
});
