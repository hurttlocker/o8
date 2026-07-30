/**
 * Filesystem-driven GitHub Actions policy coverage.
 *
 * Every workflow is discovered from disk so a newly added file is governed
 * automatically. The assertions protect repository secrets, Actions spend,
 * runner cost, action supply-chain integrity, and least-privilege defaults.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type RecordValue = Record<string, unknown>;

interface WorkflowFile {
  file: string;
  name: string;
  workflow: RecordValue;
}

interface UsesReference {
  location: string;
  uses: string;
}

const WORKFLOWS_ROOT = path.join(process.cwd(), '.github', 'workflows');

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function walkFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...walkFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

function parseWorkflow(file: string): WorkflowFile {
  const name = path.relative(WORKFLOWS_ROOT, file);
  const parsed = parse(readFileSync(file, 'utf8')) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`${name} must parse to a YAML mapping`);
  }
  return { file, name, workflow: parsed };
}

function triggerNames(workflow: RecordValue): Set<string> {
  const trigger = workflow.on;
  if (typeof trigger === 'string') return new Set([trigger]);
  if (Array.isArray(trigger)) {
    return new Set(trigger.filter((value): value is string => typeof value === 'string'));
  }
  if (isRecord(trigger)) return new Set(Object.keys(trigger));
  return new Set();
}

function collectUses(value: unknown, location: string, output: UsesReference[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectUses(entry, `${location}[${index}]`, output));
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, entry] of Object.entries(value)) {
    const childLocation = `${location}.${key}`;
    if (key === 'uses' && typeof entry === 'string') {
      output.push({ location: childLocation, uses: entry.trim() });
    }
    collectUses(entry, childLocation, output);
  }
}

function usesReferences(file: WorkflowFile): UsesReference[] {
  const references: UsesReference[] = [];
  collectUses(file.workflow.jobs, `${file.name}.jobs`, references);
  return references;
}

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (isRecord(value)) return Object.values(value).flatMap(stringsIn);
  return [];
}

function matrixValues(job: RecordValue, key: string): string[] {
  const strategy = isRecord(job.strategy) ? job.strategy : {};
  const matrix = isRecord(strategy.matrix) ? strategy.matrix : {};
  const values = stringsIn(matrix[key]);
  if (Array.isArray(matrix.include)) {
    for (const entry of matrix.include) {
      if (isRecord(entry)) values.push(...stringsIn(entry[key]));
    }
  }
  return values;
}

function usesMacOsRunner(job: RecordValue): boolean {
  const runners = stringsIn(job['runs-on']);
  if (runners.some((runner) => /^macos-/i.test(runner.trim()))) return true;

  for (const runner of runners) {
    for (const match of runner.matchAll(/matrix\.([A-Za-z0-9_-]+)/g)) {
      if (matrixValues(job, match[1]).some((value) => /^macos-/i.test(value.trim()))) {
        return true;
      }
    }
  }
  return false;
}

function jobsIn(file: WorkflowFile): Array<[string, RecordValue]> {
  if (!isRecord(file.workflow.jobs)) return [];
  return Object.entries(file.workflow.jobs).filter(
    (entry): entry is [string, RecordValue] => isRecord(entry[1]),
  );
}

const workflowFiles = walkFiles(WORKFLOWS_ROOT)
  .filter((file) => /\.ya?ml$/i.test(file))
  .sort()
  .map(parseWorkflow);

describe('workflow policy — every workflow is classified from the filesystem', () => {
  it('parses every workflow and discovers a non-vacuous workflow set', () => {
    expect(workflowFiles.length).toBeGreaterThan(0);
    for (const file of workflowFiles) {
      expect(triggerNames(file.workflow).size, `${file.name} must declare at least one trigger`).toBeGreaterThan(0);
      expect(jobsIn(file).length, `${file.name} must declare at least one job`).toBeGreaterThan(0);
    }
  });

  it('keeps pull_request_target workflows metadata-only', () => {
    const violations = workflowFiles.flatMap((file) => {
      if (!triggerNames(file.workflow).has('pull_request_target')) return [];
      const checkoutViolations = usesReferences(file)
        .filter(({ uses }) => /^actions\/checkout(?:@|\/|$)/i.test(uses))
        .map(({ location, uses }) => `${location}: ${uses}`);
      const runViolations = jobsIn(file).flatMap(([jobName, job]) => {
        const steps = Array.isArray(job.steps) ? job.steps : [];
        return steps.flatMap((step, index) => (
          isRecord(step) && typeof step.run === 'string'
            ? [`${file.name}.jobs.${jobName}.steps[${index}].run`]
            : []
        ));
      });
      return [...checkoutViolations, ...runViolations];
    });

    expect(
      violations,
      'pull_request_target runs with secrets against the base repository; checking out or running pull request-controlled content can exfiltrate them.',
    ).toEqual([]);
  });

  it('forbids push triggers, including tag pushes', () => {
    const violations = workflowFiles
      .filter((file) => triggerNames(file.workflow).has('push'))
      .map((file) => file.name);
    expect(violations, 'push-triggered Actions spend money rechecking direct pushes without review signal').toEqual([]);
  });

  it('allows macOS runners only in workflow_dispatch-only workflows', () => {
    const violations: string[] = [];
    for (const file of workflowFiles) {
      const triggers = triggerNames(file.workflow);
      const manualOnly = triggers.size === 1 && triggers.has('workflow_dispatch');
      for (const [jobName, job] of jobsIn(file)) {
        if (usesMacOsRunner(job) && !manualOnly) {
          violations.push(`${file.name}: jobs.${jobName}`);
        }
      }
    }
    expect(violations, 'macOS minutes cost 10x and are permitted only for explicitly dispatched work').toEqual([]);
  });

  it('pins every third-party action to a full commit SHA', () => {
    const violations = workflowFiles.flatMap((file) =>
      usesReferences(file)
        .filter(({ uses }) => {
          const normalized = uses.toLowerCase();
          if (normalized.startsWith('actions/')) return false;
          if (normalized.startsWith('./') || normalized.startsWith('docker://')) return false;
          return !/@[0-9a-f]{40}$/i.test(uses);
        })
        .map(({ location, uses }) => `${location}: ${uses}`),
    );
    expect(violations, 'third-party action tags are mutable; pin each action to a full 40-character commit SHA').toEqual([]);
  });

  it('requires explicit top-level permissions in every workflow', () => {
    const violations = workflowFiles
      .filter((file) => !isRecord(file.workflow.permissions))
      .map((file) => file.name);
    expect(violations, 'top-level permissions make the default token scope explicit and least-privilege').toEqual([]);
  });
});

describe('workflow policy — github-script syntax', () => {
  it('compiles every parsed github-script body as async JavaScript', () => {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (...args: unknown[]) => Promise<unknown>;

    for (const file of workflowFiles) {
      for (const [jobName, job] of jobsIn(file)) {
        const steps = Array.isArray(job.steps) ? job.steps : [];
        steps.forEach((step, index) => {
          if (!isRecord(step) || typeof step.uses !== 'string') return;
          if (!/^actions\/github-script@/i.test(step.uses)) return;
          const inputs = isRecord(step.with) ? step.with : {};
          expect(typeof inputs.script, `${file.name}: jobs.${jobName}.steps[${index}] needs a script`).toBe('string');
          expect(
            () => new AsyncFunction('github', 'context', 'core', 'require', String(inputs.script)),
            `${file.name}: jobs.${jobName}.steps[${index}] has invalid JavaScript`,
          ).not.toThrow();
        });
      }
    }
  });
});
