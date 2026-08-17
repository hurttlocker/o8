import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

interface PromotionInput {
  cycle: number;
  dataDir: string;
  repoPath: string;
  packetId: string;
  surfaceId: string;
  repoId?: string;
  laneId?: string;
  workspacePath?: string;
}

interface CreateResult {
  status: number;
  body?: unknown;
  repo?: { id: string; installOnCreateWorkspace: boolean };
  worktree?: { id: string; path: string; branch: string; dependencyRecipeKey: string };
  laneId?: string;
  reviewedHead?: string;
  reviewedTree?: string;
  fullDiff?: string;
  install?: InstallEvidence;
  rootNodeModulesAbsent?: boolean;
}

interface InstallEvidence {
  receipt: Record<string, string | null>;
  effectCount: number;
  privateWritableDirectory: boolean;
}

interface ReviewEvidence {
  source: {
    kind: 'immutable_snapshot' | 'materialized';
    headCommit?: string;
    treeSha?: string;
    diffFingerprint?: string;
    recoveryRef?: string;
  };
  headSha: string;
  full: string;
}

interface LifecycleResult {
  route: { durationMs: number; status: number; body: Record<string, unknown> };
  pathAbsent?: boolean;
  pathPresent?: boolean;
  snapshot: {
    state: string;
    headCommit: string;
    treeSha: string;
    recoveryRef: string;
    diffFingerprint: string;
    dependencyRecipeKey: string;
  };
  review: ReviewEvidence;
  bytes?: {
    logicalBefore: number | null;
    logicalAfter: number;
    availableBefore: number | null;
    availableAfter: number | null;
    reclaimedAvailable: number | null;
  };
  head?: string;
  tree?: string;
  tracked?: string;
  install?: InstallEvidence;
  setupRecipeKey?: string | null;
  rootNodeModulesAbsent?: boolean;
  cacheAuthorityPrivate?: boolean;
  cacheContainsSecret?: boolean;
  cacheContainsPrivateMutation?: boolean;
}

interface CycleMetric {
  cycle: number;
  parkMs: number;
  restoreMs: number;
  logicalBefore: number;
  reclaimedAvailable: number;
  headCommit: string;
  treeSha: string;
  recoveryRef: string;
  diffFingerprint: string;
  parkedReviewKind: ReviewEvidence['source']['kind'];
  restoredReviewKind: ReviewEvidence['source']['kind'];
  graceResume: boolean;
}

const configuredCycles = Number(process.env.O8_THIN_WORKSPACE_PROMOTION_CYCLES ?? '1');
const promotionCycles = Number.isSafeInteger(configuredCycles)
  && configuredCycles >= 1
  && configuredCycles <= 20
  ? configuredCycles
  : 1;
const roots: string[] = [];
const secret = 'thin-promotion-private-token';
const childPath = path.join(process.cwd(), 'tests/fixtures/thin-workspace-promotion-child.ts');
const restoreGraceMs = 120_000;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function directoryContainsBytes(candidate: string, needle: string): boolean {
  const bytes = Buffer.from(needle);
  const visit = (entryPath: string): boolean => {
    const entry = lstatSync(entryPath);
    if (entry.isSymbolicLink()) return false;
    if (entry.isFile()) return readFileSync(entryPath).includes(bytes);
    if (!entry.isDirectory()) return false;
    return readdirSync(entryPath).some((name) => visit(path.join(entryPath, name)));
  };
  return visit(candidate);
}

function createRepo(root: string, name: string, credentialConfig = false): string {
  const repoPath = path.join(root, 'repo');
  mkdirSync(repoPath);
  git(repoPath, 'init', '-q', '-b', 'main');
  git(repoPath, 'config', 'user.name', 'o8 test');
  git(repoPath, 'config', 'user.email', 'o8-test@example.test');
  writeFileSync(path.join(repoPath, '.gitignore'), 'node_modules/\n');
  writeFileSync(path.join(repoPath, 'tracked.txt'), 'base\n');
  writeFileSync(path.join(repoPath, 'package.json'), JSON.stringify({
    name,
    version: '1.0.0',
    private: true,
    packageManager: `npm@${execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim()}`,
    scripts: {
      postinstall: "node -e \"const fs=require('fs');const p='node_modules/postinstall-private';fs.mkdirSync(p,{recursive:true});fs.appendFileSync(p+'/effects.log','run\\n');fs.writeFileSync(p+'/blob.bin',Buffer.alloc(2*1024*1024,7));fs.writeFileSync(p+'/receipt.json',JSON.stringify({token:process.env.NPM_TOKEN??null,nodeOptions:process.env.NODE_OPTIONS??null,home:process.env.HOME??null,config:process.env.XDG_CONFIG_HOME??null,temp:process.env.TMPDIR??null,corepack:process.env.COREPACK_HOME??null,cache:process.env.npm_config_cache??null}))\"",
    },
  }));
  execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], {
    cwd: repoPath,
    stdio: 'ignore',
  });
  if (credentialConfig) {
    writeFileSync(path.join(repoPath, '.npmrc'), '//registry.invalid/:_authToken=${NPM_TOKEN}\n');
  }
  git(
    repoPath,
    'add',
    '.gitignore',
    'tracked.txt',
    'package.json',
    'package-lock.json',
    ...(credentialConfig ? ['.npmrc'] : []),
  );
  git(repoPath, 'commit', '-qm', 'fixture');
  return repoPath;
}

function runChild<T>(action: 'create' | 'park' | 'restore', input: PromotionInput): T {
  const output = execFileSync(
    path.join(process.cwd(), 'node_modules/.bin/tsx'),
    [childPath, action],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS?.trim(), '--conditions=react-server']
          .filter(Boolean)
          .join(' '),
        O8_DATA_DIR: input.dataDir,
        CORTEX_IDE_DATA_DIR: input.dataDir,
        O8_WORKTREE_ROOT: path.join(path.dirname(input.dataDir), 'worktrees'),
        O8_SKIP_PRELAUNCH_TYPECHECK: '1',
        O8_STORAGE_RESERVE_RATIO: '0.000001',
        O8_STORAGE_RESERVE_FLOOR_GB: '0.001',
        NPM_TOKEN: secret,
        npm_config_registry: 'https://credential.invalid/',
        O8_PROMOTION_INPUT: JSON.stringify(input),
      },
    },
  );
  const line = output.split('\n').find((entry) => entry.startsWith('O8_PROMOTION_RESULT '));
  if (!line) throw new Error(`Promotion child returned no receipt: ${output}`);
  return JSON.parse(line.slice('O8_PROMOTION_RESULT '.length)) as T;
}

function percentile(samples: number[], percentileValue: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(percentileValue * sorted.length) - 1]!;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('persisted dependency recipe through production workspace routes', () => {
  it(`runs ${promotionCycles} isolated create, park, and restore cycles across process boundaries`, () => {
    const metrics: CycleMetric[] = [];
    for (let cycle = 1; cycle <= promotionCycles; cycle += 1) {
      const root = mkdtempSync(path.join(os.tmpdir(), `o8-thin-promotion-${cycle}-`));
      roots.push(root);
      const dataDir = path.join(root, 'data');
      const worktreeRoot = path.join(root, 'worktrees');
      mkdirSync(dataDir);
      mkdirSync(worktreeRoot);
      const repoPath = createRepo(root, `thin-promotion-${cycle}`);
      const packetId = `packet-thin-promotion-${cycle}`;
      const surfaceId = `thin-promotion-owned:${cycle}`;
      const createInput = { cycle, dataDir, repoPath, packetId, surfaceId };
      const created = runChild<CreateResult>('create', createInput);
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.repo?.installOnCreateWorkspace).toBe(true);
      expect(created.worktree?.dependencyRecipeKey).toMatch(/^[0-9a-f]{64}$/);
      expect(created.install).toMatchObject({
        effectCount: 1,
        privateWritableDirectory: true,
        receipt: { token: null, nodeOptions: null },
      });
      expect(created.install?.receipt.home).toContain(`${path.sep}.o8-install-runtime${path.sep}`);
      expect(created.install?.receipt.cache).toContain(created.worktree!.dependencyRecipeKey);
      expect(existsSync(path.dirname(created.install!.receipt.home!))).toBe(false);
      expect(created.rootNodeModulesAbsent).toBe(true);

      const lifecycleInput = {
        ...createInput,
        repoId: created.repo!.id,
        laneId: created.laneId!,
        workspacePath: created.worktree!.path,
      };
      const parked = runChild<LifecycleResult>('park', lifecycleInput);
      expect(parked.route.status, JSON.stringify(parked.route.body)).toBe(200);
      expect(parked.route.body).toMatchObject({ ok: true, result: { status: 'parked' } });
      expect(parked.pathAbsent).toBe(true);
      expect(parked.snapshot).toMatchObject({
        state: 'parked',
        headCommit: created.reviewedHead,
        treeSha: created.reviewedTree,
      });
      expect(parked.snapshot.dependencyRecipeKey).toMatch(/^[0-9a-f]{64}$/);
      expect(parked.snapshot.dependencyRecipeKey)
        .not.toBe(created.worktree!.dependencyRecipeKey);
      expect(parked.review.source).toMatchObject({
        kind: 'immutable_snapshot',
        headCommit: created.reviewedHead,
        treeSha: created.reviewedTree,
        recoveryRef: parked.snapshot.recoveryRef,
        diffFingerprint: parked.snapshot.diffFingerprint,
      });
      expect(parked.review.headSha).toBe(created.reviewedHead);
      expect(parked.review.full).toBe(created.fullDiff);
      expect(parked.bytes?.logicalBefore).toBeGreaterThan(2 * 1024 * 1024);
      expect(parked.bytes?.logicalAfter).toBe(0);

      const restored = runChild<LifecycleResult>('restore', lifecycleInput);
      expect(restored.route.status, JSON.stringify(restored.route.body)).toBe(200);
      expect(restored.route.body).toMatchObject({ ok: true, result: { status: 'restored' } });
      expect(restored.pathPresent).toBe(true);
      expect(restored.snapshot).toMatchObject({
        state: 'materialized',
        headCommit: created.reviewedHead,
        treeSha: created.reviewedTree,
        recoveryRef: parked.snapshot.recoveryRef,
        diffFingerprint: parked.snapshot.diffFingerprint,
        dependencyRecipeKey: parked.snapshot.dependencyRecipeKey,
      });
      expect(restored.review.source.kind).toBe('materialized');
      expect(restored.review.headSha).toBe(created.reviewedHead);
      expect(restored.review.full).toBe(created.fullDiff);
      expect(restored.head).toBe(created.reviewedHead);
      expect(restored.tree).toBe(created.reviewedTree);
      expect(restored.tracked).toBe(`reviewed cycle ${cycle}\n`);
      expect(restored.install).toMatchObject({
        effectCount: 1,
        privateWritableDirectory: true,
        receipt: {
          token: null,
          nodeOptions: null,
        },
      });
      const restoredCachePath = restored.install!.receipt.cache!;
      expect(path.basename(restoredCachePath)).toBe('cache');
      expect(path.basename(path.dirname(restoredCachePath))).toMatch(/^[0-9a-f]{64}$/);
      expect(path.basename(path.dirname(path.dirname(restoredCachePath)))).toBe('npm');
      expect(restored.install!.receipt.cache).not.toBe(created.install!.receipt.cache);
      for (const name of ['home', 'config', 'temp', 'corepack'] as const) {
        expect(restored.install!.receipt[name]).not.toBe(created.install!.receipt[name]);
      }
      expect(existsSync(path.dirname(restored.install!.receipt.home!))).toBe(false);
      expect(restored.setupRecipeKey).toBe(parked.snapshot.dependencyRecipeKey);
      expect(restored.rootNodeModulesAbsent).toBe(true);
      expect(restored.cacheAuthorityPrivate).toBe(true);
      expect(restored.cacheContainsSecret).toBe(false);
      expect(restored.cacheContainsPrivateMutation).toBe(false);
      writeFileSync(
        path.join(created.worktree!.path, 'node_modules/postinstall-private/private-mutation'),
        'private-workspace-mutation',
      );
      expect(directoryContainsBytes(dataDir, 'private-workspace-mutation')).toBe(false);
      expect(directoryContainsBytes(dataDir, secret)).toBe(false);

      metrics.push({
        cycle,
        parkMs: parked.route.durationMs,
        restoreMs: restored.route.durationMs,
        logicalBefore: parked.bytes!.logicalBefore!,
        reclaimedAvailable: parked.bytes!.reclaimedAvailable!,
        headCommit: restored.head!,
        treeSha: restored.tree!,
        recoveryRef: restored.snapshot.recoveryRef,
        diffFingerprint: restored.snapshot.diffFingerprint,
        parkedReviewKind: parked.review.source.kind,
        restoredReviewKind: restored.review.source.kind,
        graceResume: restored.route.durationMs < restoreGraceMs,
      });
    }
    const parkTimes = metrics.map((metric) => metric.parkMs);
    const restoreTimes = metrics.map((metric) => metric.restoreMs);
    const summary = {
      cycles: metrics.length,
      parkP50Ms: percentile(parkTimes, 0.5),
      parkP95Ms: percentile(parkTimes, 0.95),
      restoreP50Ms: percentile(restoreTimes, 0.5),
      restoreP95Ms: percentile(restoreTimes, 0.95),
      restoreGraceMs,
      graceResumeRate: metrics.filter((metric) => metric.graceResume).length / metrics.length,
      cycleMetrics: metrics,
    };
    console.log(`[thin-workspaces-promotion] ${JSON.stringify(summary)}`);
    expect(summary.restoreP95Ms).toBeLessThan(restoreGraceMs);
    expect(summary.graceResumeRate).toBe(1);
  }, promotionCycles * 240_000);

  it('returns a structured refusal for a tracked credential binding before install effects', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'o8-thin-promotion-refusal-'));
    roots.push(root);
    const dataDir = path.join(root, 'data');
    mkdirSync(dataDir);
    mkdirSync(path.join(root, 'worktrees'));
    const repoPath = createRepo(root, 'thin-promotion-refusal', true);
    const result = runChild<CreateResult>('create', {
      cycle: 0,
      dataDir,
      repoPath,
      packetId: 'packet-thin-promotion-refusal',
      surfaceId: 'thin-promotion-owned:refusal',
    });
    expect(result.status).toBe(422);
    expect(result.body).toEqual({
      error: {
        code: 'dependency_authentication_unsupported',
        message: 'Credential-bearing package-manager configuration is unsupported for public dependency installs.',
      },
    });
    expect(existsSync(path.join(repoPath, 'node_modules'))).toBe(false);
    expect(directoryContainsBytes(dataDir, secret)).toBe(false);
  }, 120_000);
});
