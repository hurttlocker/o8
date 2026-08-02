import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const validatorPath = path.join(repoRoot, 'scripts', 'validate-qa-cases.ts');
const tsxPath = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const tempDirs: string[] = [];
const categories = ['ownership', 'decisions', 'processes', 'incidents', 'specs', 'cross-repo'];

function makeCases(repoPath: string) {
  return {
    version: 1,
    cases: categories.flatMap((category) => Array.from({ length: 5 }, (_, index) => ({
      id: `${category}-${index}`,
      category,
      repoPath,
      question: 'What changed?',
      expectedAnswer: null,
      expectedFacts: [],
      expectedCitations: [],
      rubric: {
        factual_accuracy_threshold: 0.7,
        citation_correctness_threshold: 0.7,
        max_hallucinations: 0,
      },
    }))),
  };
}

function runValidator(declaredPath: string | null, environmentPath?: string) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'o8-validate-qa-cases-'));
  tempDirs.push(cwd);
  const resolvedDeclaredPath = declaredPath ?? path.join(cwd, 'missing-repo');
  const casesDir = path.join(cwd, 'tests', 'qa-eval');
  mkdirSync(casesDir, { recursive: true });
  writeFileSync(path.join(casesDir, 'cases.json'), JSON.stringify(makeCases(resolvedDeclaredPath)));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: cwd };
  delete env.O8_EVAL_REPO_PATH;
  if (environmentPath) env.O8_EVAL_REPO_PATH = environmentPath;
  return {
    declaredPath: resolvedDeclaredPath,
    result: spawnSync(tsxPath, [validatorPath], { cwd, env, encoding: 'utf8' }),
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('validate-qa-cases repoPath preflight', () => {
  it('exits non-zero and names a repoPath that cannot resolve to a Git checkout', () => {
    const { declaredPath, result } = runValidator(null);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`repoPath ${JSON.stringify(declaredPath)} is unresolvable`);
    expect(result.stderr).toContain('no candidate contains .git');
  });

  it('warns when the environment override substitutes for the declared repoPath', () => {
    const fallbackRepo = mkdtempSync(path.join(os.tmpdir(), 'o8-qa-fallback-repo-'));
    tempDirs.push(fallbackRepo);
    mkdirSync(path.join(fallbackRepo, '.git'));
    const declaredPath = '/workspace/o8';
    const { result } = runValidator(declaredPath, fallbackRepo);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      `declared repoPath ${JSON.stringify(declaredPath)} was not selected; O8_EVAL_REPO_PATH overrides it with ${JSON.stringify(fallbackRepo)}`,
    );
  });
});
