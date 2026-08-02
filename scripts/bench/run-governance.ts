#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { evaluateDiff } from '../../src/lib/harness/evaluator';
import {
  loadGovernanceFixtures,
  matchedExpectedDefect,
  preflightGovernanceFixture,
  scoreGovernanceResults,
  shuffleGovernanceFixtures,
  type GovernanceReviewResult,
} from './governance';

const repoRoot = process.cwd();
const latestDir = path.join(repoRoot, 'tests', 'bench', 'latest');
const outputPath = path.join(latestDir, 'governance.json');
const scopeStatement = 'This benchmark measures the AI review tier. It does not measure the human approval gate above it.';
const defaultReviewTimeoutMs = 180_000;

function reviewTimeoutMs(): number {
  const configured = Number(process.env.BENCH_GOVERNANCE_REVIEW_TIMEOUT_MS ?? defaultReviewTimeoutMs);
  if (!Number.isInteger(configured) || configured < 10_000 || configured > 600_000) {
    throw new Error('BENCH_GOVERNANCE_REVIEW_TIMEOUT_MS must be an integer from 10000 to 600000');
  }
  return configured;
}

function packageVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version?: unknown };
  return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
}

function gitSha(): string {
  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function createBlindReviewRepo(): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'o8-governance-review-'));
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: repoPath });
  return repoPath;
}

function removeBlindReviewRepo(repoPath: string): void {
  if (
    path.dirname(repoPath) === path.resolve(os.tmpdir())
    && path.basename(repoPath).startsWith('o8-governance-review-')
  ) {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const fixtures = loadGovernanceFixtures();
  const timeoutMs = reviewTimeoutMs();
  console.log(`[governance] preflighting ${fixtures.length} committed patch fixtures through TypeScript and ESLint`);
  for (const fixture of fixtures) preflightGovernanceFixture(fixture, repoRoot);
  console.log('[governance] mechanical fixture gates passed');

  const blindInputs = shuffleGovernanceFixtures(fixtures);
  const results: GovernanceReviewResult[] = [];
  console.log(`[governance] blind order: ${blindInputs.map((input) => input.neutralLabel).join(', ')}`);
  for (const input of blindInputs) {
    const diff = fs.readFileSync(input.fixture.patchPath, 'utf8');
    console.log(`[governance] reviewing ${input.neutralLabel}`);
    const reviewRepo = createBlindReviewRepo();
    const evaluation = await evaluateDiff({
      repoPath: reviewRepo,
      task: input.fixture.task,
      acceptanceCriteria: input.fixture.acceptanceCriteria,
      diff,
      signal: AbortSignal.timeout(timeoutMs),
      disallowTools: true,
    }).finally(() => removeBlindReviewRepo(reviewRepo));
    results.push({ ...input, evaluation });
    console.log(`[governance] ${input.neutralLabel}: ${evaluation.verdict} (${evaluation.findings.length} findings)`);
  }

  const summary = scoreGovernanceResults(results);
  const reviewerBackends = [...new Set(results.map((result) => result.evaluation.reviewerBackend ?? 'unknown'))];
  const payload = {
    schema: 'o8/governance-benchmark/v1',
    generatedAt: new Date().toISOString(),
    version: packageVersion(),
    gitSha: gitSha(),
    fixtureManifest: 'tests/bench/governance/manifest.json',
    fixtureCount: fixtures.length,
    reviewerBackends,
    scopeStatement,
    blindExecution: {
      shuffled: true,
      neutralLabels: blindInputs.map((input) => input.neutralLabel),
      groundTruthWithheldFromReviewer: true,
      isolatedRepositoryPerInput: true,
      reviewerPermissionMode: 'plan',
      reviewerToolProfile: 'propose',
      reviewerToolsForbidden: true,
      toolProtocolBreachIsInconclusive: true,
    },
    mechanicalGates: {
      typescript: { passed: true, fixtures: fixtures.length },
      eslint: { passed: true, fixtures: fixtures.length },
    },
    reviewTimeoutMs: timeoutMs,
    summary,
    results: results.map((result) => ({
      neutralLabel: result.neutralLabel,
      fixtureId: result.fixture.id,
      classification: result.fixture.groundTruth.classification,
      defect: result.fixture.groundTruth.defect,
      verdict: result.evaluation.verdict,
      findings: result.evaluation.findings,
      matchedExpectedDefect: matchedExpectedDefect(result),
      risk: result.evaluation.risk,
      riskReasons: result.evaluation.riskReasons,
      reviewerBackend: result.evaluation.reviewerBackend,
      reviewedAt: result.evaluation.reviewedAt,
    })),
  };

  fs.mkdirSync(latestDir, { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);

  console.log(`[governance] ${scopeStatement}`);
  console.log(`[governance] Catch rate: ${summary.catch.caught}/${summary.catch.total} (${percent(summary.catch.rate)}) planted defects found.`);
  console.log(`[governance] False-positive rate: ${summary.falsePositive.flagged}/${summary.falsePositive.total} (${percent(summary.falsePositive.rate)}) clean diffs wrongly flagged.`);
  console.log(`[governance] Inconclusive reviews: ${summary.inconclusive}/${fixtures.length}.`);
  console.log(`[governance] wrote ${outputPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`[governance] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
