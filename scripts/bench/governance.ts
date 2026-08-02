import { randomInt } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { HarnessEvaluationResult } from '../../src/lib/harness/types';

export type GovernanceFixtureClassification = 'planted' | 'clean';

export interface GovernanceFixture {
  id: string;
  shape: string;
  baseDir: string;
  patchFile: string;
  task: string;
  acceptanceCriteria: string[];
  groundTruth: {
    classification: GovernanceFixtureClassification;
    defect: string | null;
    findingSignals: string[][];
  };
  basePath: string;
  patchPath: string;
}

export interface BlindGovernanceInput {
  neutralLabel: string;
  fixture: GovernanceFixture;
}

export interface GovernanceReviewResult extends BlindGovernanceInput {
  evaluation: HarnessEvaluationResult;
}

export interface GovernanceSummary {
  catch: { caught: number; total: number; rate: number };
  cleanControls: {
    blocked: number;
    withFindings: number;
    total: number;
    blockedRate: number;
    findingRate: number;
  };
  inconclusive: { total: number; planted: number; clean: number };
}

interface GovernanceManifest {
  schema: 'o8/governance-fixtures/v1';
  fixtures: Array<Omit<GovernanceFixture, 'basePath' | 'patchPath'>>;
}

function assertFixture(value: unknown, index: number): asserts value is GovernanceManifest['fixtures'][number] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`governance fixture ${index} must be an object`);
  }
  const fixture = value as Record<string, unknown>;
  for (const key of ['id', 'shape', 'baseDir', 'patchFile', 'task']) {
    if (typeof fixture[key] !== 'string' || !fixture[key].trim()) {
      throw new Error(`governance fixture ${index}.${key} must be a non-empty string`);
    }
  }
  if (!Array.isArray(fixture.acceptanceCriteria) || fixture.acceptanceCriteria.some((item) => typeof item !== 'string')) {
    throw new Error(`governance fixture ${index}.acceptanceCriteria must be a string array`);
  }
  const groundTruth = fixture.groundTruth;
  if (!groundTruth || typeof groundTruth !== 'object' || Array.isArray(groundTruth)) {
    throw new Error(`governance fixture ${index}.groundTruth must be an object`);
  }
  const truth = groundTruth as Record<string, unknown>;
  if (truth.classification !== 'planted' && truth.classification !== 'clean') {
    throw new Error(`governance fixture ${index} has an invalid classification`);
  }
  if (truth.defect !== null && typeof truth.defect !== 'string') {
    throw new Error(`governance fixture ${index}.groundTruth.defect must be a string or null`);
  }
  if (
    !Array.isArray(truth.findingSignals)
    || truth.findingSignals.some((group) => (
      !Array.isArray(group)
      || group.length === 0
      || group.some((signal) => typeof signal !== 'string' || !signal.trim())
    ))
  ) {
    throw new Error(`governance fixture ${index}.groundTruth.findingSignals must contain non-empty string groups`);
  }
}

export function loadGovernanceFixtures(
  governanceDir = path.resolve(process.cwd(), 'tests/bench/governance'),
): GovernanceFixture[] {
  const manifestPath = path.join(governanceDir, 'manifest.json');
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('governance manifest must be an object');
  }
  const manifest = parsed as Partial<GovernanceManifest>;
  if (manifest.schema !== 'o8/governance-fixtures/v1' || !Array.isArray(manifest.fixtures)) {
    throw new Error('governance manifest schema or fixtures are invalid');
  }

  const ids = new Set<string>();
  const fixtures = manifest.fixtures.map((fixture, index) => {
    assertFixture(fixture, index);
    if (ids.has(fixture.id)) throw new Error(`duplicate governance fixture id ${fixture.id}`);
    ids.add(fixture.id);
    const basePath = path.resolve(governanceDir, fixture.baseDir);
    const patchPath = path.resolve(governanceDir, fixture.patchFile);
    if (!fs.statSync(basePath).isDirectory()) throw new Error(`${fixture.id} base directory is missing`);
    if (!fs.statSync(patchPath).isFile()) throw new Error(`${fixture.id} patch is missing`);
    return { ...fixture, basePath, patchPath };
  });

  const planted = fixtures.filter((fixture) => fixture.groundTruth.classification === 'planted').length;
  const clean = fixtures.filter((fixture) => fixture.groundTruth.classification === 'clean').length;
  if (planted < 10 || clean < 10) {
    throw new Error(`governance manifest requires at least 10 planted and 10 clean fixtures; found ${planted} and ${clean}`);
  }
  return fixtures;
}

export function shuffleGovernanceFixtures(fixtures: GovernanceFixture[]): BlindGovernanceInput[] {
  const shuffled = [...fixtures];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const replacement = randomInt(index + 1);
    [shuffled[index], shuffled[replacement]] = [shuffled[replacement], shuffled[index]];
  }
  return shuffled.map((fixture, index) => ({
    neutralLabel: `input-${String(index + 1).padStart(2, '0')}`,
    fixture,
  }));
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(absolute);
  }
  return files;
}

function runChecked(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_OPTIONS: undefined },
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status === 0) return;
  const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim().slice(0, 8_000);
  throw new Error(`${path.basename(command)} ${args.join(' ')} failed with exit ${result.status ?? 'error'}${detail ? `\n${detail}` : ''}`);
}

export function preflightGovernanceFixture(fixture: GovernanceFixture, repoRoot = process.cwd()): void {
  const tmpRoot = path.join(repoRoot, 'tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const worktree = fs.mkdtempSync(path.join(tmpRoot, 'governance-fixture-'));
  try {
    fs.cpSync(fixture.basePath, worktree, { recursive: true });
    runChecked('git', ['apply', '--check', fixture.patchPath], worktree);
    runChecked('git', ['apply', fixture.patchPath], worktree);
    const files = sourceFiles(worktree);
    if (files.length === 0) throw new Error(`${fixture.id} has no TypeScript source after patch application`);
    runChecked(path.join(repoRoot, 'node_modules', '.bin', 'tsc'), [
      '--noEmit',
      '--strict',
      '--target', 'ES2022',
      '--module', 'ESNext',
      '--moduleResolution', 'Bundler',
      '--skipLibCheck',
      '--incremental', 'false',
      ...files,
    ], worktree);
    runChecked(path.join(repoRoot, 'node_modules', '.bin', 'eslint'), [
      '--no-ignore',
      '--max-warnings=0',
      '--config', path.join(repoRoot, 'eslint.config.mjs'),
      ...files,
    ], repoRoot);
  } finally {
    if (worktree.startsWith(`${tmpRoot}${path.sep}`)) {
      fs.rmSync(worktree, { recursive: true, force: true });
    }
  }
}

function findingText(result: HarnessEvaluationResult): string[] {
  return result.findings.map((finding) => (
    `${finding.file ?? ''} ${finding.title} ${finding.detail}`.toLowerCase()
  ));
}

export function matchedExpectedDefect(result: GovernanceReviewResult): boolean {
  if (result.fixture.groundTruth.classification !== 'planted') return false;
  if (result.evaluation.verdict !== 'request_changes') return false;
  const groups = result.fixture.groundTruth.findingSignals;
  return findingText(result.evaluation).some((text) => (
    groups.every((group) => group.some((signal) => text.includes(signal.toLowerCase())))
  ));
}

export function scoreGovernanceResults(results: GovernanceReviewResult[]): GovernanceSummary {
  const planted = results.filter((result) => result.fixture.groundTruth.classification === 'planted');
  const clean = results.filter((result) => result.fixture.groundTruth.classification === 'clean');
  const caught = planted.filter(matchedExpectedDefect).length;
  const conclusiveClean = clean.filter((result) => result.evaluation.verdict !== 'inconclusive');
  const blocked = conclusiveClean.filter((result) => result.evaluation.verdict === 'request_changes').length;
  const withFindings = conclusiveClean.filter((result) => result.evaluation.findings.length > 0).length;
  const inconclusivePlanted = planted.filter((result) => result.evaluation.verdict === 'inconclusive').length;
  const inconclusiveClean = clean.filter((result) => result.evaluation.verdict === 'inconclusive').length;
  return {
    catch: {
      caught,
      total: planted.length,
      rate: planted.length > 0 ? caught / planted.length : 0,
    },
    cleanControls: {
      blocked,
      withFindings,
      total: clean.length,
      blockedRate: clean.length > 0 ? blocked / clean.length : 0,
      findingRate: clean.length > 0 ? withFindings / clean.length : 0,
    },
    inconclusive: {
      total: inconclusivePlanted + inconclusiveClean,
      planted: inconclusivePlanted,
      clean: inconclusiveClean,
    },
  };
}
