import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

const source = readFileSync(resolve('.github/workflows/nightly.yml'), 'utf8');
const workflow = parse(source);

async function freshness(eventName: string, previousSha?: string) {
  const listWorkflowRuns = vi.fn(async () => ({ data: {
    workflow_runs: previousSha ? [{ head_sha: previousSha }] : [],
  } }));
  const setOutput = vi.fn();
  const summary = { addRaw: vi.fn().mockReturnThis(), write: vi.fn(async () => {}) };
  const step = workflow.jobs.verify.steps.find((candidate: { id?: string }) => candidate.id === 'freshness');
  await runInNewContext(`(async () => { ${step.with.script} })()`, {
    github: { rest: { actions: { listWorkflowRuns } } },
    context: { eventName, sha: 'current-sha', repo: { owner: 'fixture', repo: 'fixture' },
      payload: { repository: { default_branch: 'main' } } },
    core: { setOutput, summary },
  }, { timeout: 1000 });
  return { listWorkflowRuns, setOutput };
}

describe('nightly source-verification policy', () => {
  it('stays read-only, time-bounded, and on the default branch', () => {
    expect(workflow.on).toEqual({ schedule: [{ cron: '23 6 * * *' }], workflow_dispatch: null });
    expect(workflow.permissions).toEqual({ contents: 'read', actions: 'read' });
    expect(workflow.jobs.verify.if).toBe('github.ref_name == github.event.repository.default_branch');
    expect(workflow.jobs.verify['timeout-minutes']).toBe(20);
    expect(workflow.concurrency['cancel-in-progress']).toBe(true);
    expect(source).not.toContain('secrets.');
    expect(workflow.jobs.verify.steps.filter((step: { run?: string }) => step.run)
      .flatMap((step: { run: string }) => step.run.trim().split('\n'))).toEqual([
      'npm install -g npm@11', 'npm ci --prefer-offline',
      'npm run protocol:check', 'npm run typecheck', 'npm run test:classification:check',
      'npm run test:unit',
    ]);
    for (const step of workflow.jobs.verify.steps.slice(1)) {
      expect(step.if).toBe("steps.freshness.outputs.run == 'true'");
    }
  });

  it('skips a scheduled commit that already passed this workflow', async () => {
    const result = await freshness('schedule', 'current-sha');
    expect(result.setOutput).toHaveBeenCalledWith('run', 'false');
    expect(result.listWorkflowRuns).toHaveBeenCalledWith(expect.objectContaining({
      workflow_id: 'nightly.yml', branch: 'main', status: 'success', per_page: 1,
    }));
  });

  it.each([undefined, 'older-sha'])('checks new or not-yet-proven source (%s)', async (previousSha) => {
    expect((await freshness('schedule', previousSha)).setOutput).toHaveBeenCalledWith('run', 'true');
  });

  it('allows an explicit manual rerun of the same source', async () => {
    const result = await freshness('workflow_dispatch', 'current-sha');
    expect(result.setOutput).toHaveBeenCalledWith('run', 'true');
    expect(result.listWorkflowRuns).not.toHaveBeenCalled();
  });
});
