import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-automation-precheck-data-'));
const repoPath = mkdtempSync(join(tmpdir(), 'o8-automation-precheck-repo-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

const runAutomation = vi.fn(async () => ({
  ok: true,
  laneId: 'lane-precheck-test',
  note: 'automation launched',
}));

vi.mock('@/lib/automations/runner', () => ({ runAutomation }));

const automationsRoute = await import('@/app/api/automations/route');
const runRoute = await import('@/app/api/automations/[id]/run/route');
const { ensureAutomationPrecheck, runBoundedAutomationPrecheck } = await import('@/lib/automations/precheck');
const { runClaimedAutomationFire } = await import('@/lib/automations/fire-runner');
const {
  claimNextAutomationFire,
  getAutomationFire,
  persistManualAutomationFire,
  recoverExpiredAutomationFires,
} = await import('@/lib/automations/fire-store');
const { getSqlite } = await import('@/lib/db');

function nodeCommand(script: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

async function createAutomation(input: {
  name: string;
  precheckCommand: string;
  precheckTimeoutMs?: number;
}): Promise<{ id: string }> {
  const response = await automationsRoute.POST(new Request('http://localhost/api/automations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: input.name,
      owner: 'test-owner',
      repoPath,
      branch: 'main',
      runtime: 'codex',
      prompt: 'Run the bounded task.',
      triggerKind: 'manual',
      precheckCommand: input.precheckCommand,
      precheckTimeoutMs: input.precheckTimeoutMs ?? 10_000,
    }),
  }));
  expect(response.status).toBe(200);
  const body = await response.json() as { automation: { id: string } };
  return body.automation;
}

async function runManual(automationId: string, input: { mutation: string; runAnyway?: boolean }) {
  const response = await runRoute.POST(new Request(`http://localhost/api/automations/${automationId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientMutationId: input.mutation,
      runAnyway: input.runAnyway === true,
    }),
  }), { params: Promise.resolve({ id: automationId }) });
  return {
    response,
    body: await response.json() as {
      ok: boolean;
      fire: {
        id: string;
        status: string;
        precheckStatus: string;
        precheckExitCode: number | null;
        precheckStdoutTail: string | null;
      };
    },
  };
}

beforeEach(() => {
  runAutomation.mockClear();
  getSqlite().prepare('DELETE FROM automations').run();
  getSqlite().prepare("DELETE FROM cloud_jobs WHERE team_id = 'automation'").run();
});

afterAll(() => {
  rmSync(repoPath, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('automation prechecks through the production routes and durable fire runner', () => {
  it('records pass and skip decisions before any model launch', async () => {
    const pass = await createAutomation({
      name: 'pass precheck',
      precheckCommand: nodeCommand("process.stdout.write('ready')"),
    });
    const passed = await runManual(pass.id, { mutation: 'pass-1' });
    expect(passed.response.status).toBe(200);
    expect(passed.body).toMatchObject({
      ok: true,
      fire: { status: 'succeeded', precheckStatus: 'passed', precheckExitCode: 0 },
    });
    expect(runAutomation).toHaveBeenCalledTimes(1);

    runAutomation.mockClear();
    const skip = await createAutomation({
      name: 'skip precheck',
      precheckCommand: nodeCommand("process.stdout.write(process.env.HOME || ''); process.exit(7)"),
    });
    const skipped = await runManual(skip.id, { mutation: 'skip-1' });
    expect(skipped.response.status).toBe(200);
    expect(skipped.body).toMatchObject({
      ok: true,
      fire: { status: 'skipped_precheck', precheckStatus: 'skipped', precheckExitCode: 7 },
    });
    expect(skipped.body.fire.precheckStdoutTail).toBe('~');
    expect(runAutomation).not.toHaveBeenCalled();
  });

  it('fails closed on timeout and supports a new auditable run-anyway fire', async () => {
    const automation = await createAutomation({
      name: 'timeout precheck',
      precheckCommand: nodeCommand('setTimeout(() => {}, 60_000)'),
      precheckTimeoutMs: 1_000,
    });
    const timedOut = await runManual(automation.id, { mutation: 'timeout-1' });
    expect(timedOut.response.status).toBe(502);
    expect(timedOut.body).toMatchObject({
      ok: false,
      fire: { status: 'precheck_error', precheckStatus: 'error' },
    });
    expect(runAutomation).not.toHaveBeenCalled();

    const forced = await runManual(automation.id, { mutation: 'timeout-override-1', runAnyway: true });
    expect(forced.response.status).toBe(200);
    expect(forced.body).toMatchObject({
      ok: true,
      fire: { status: 'succeeded', precheckStatus: 'bypassed' },
    });
    expect(forced.body.fire.id).not.toBe(timedOut.body.fire.id);
    expect(runAutomation).toHaveBeenCalledTimes(1);
  });

  it('does not rerun a completed precheck after lease recovery', async () => {
    const markerPath = join(repoPath, 'precheck-count.txt');
    const automation = await createAutomation({
      name: 'recovered precheck',
      precheckCommand: nodeCommand(`require('fs').appendFileSync(${JSON.stringify(markerPath)}, 'x')`),
    });
    const fire = persistManualAutomationFire(automation.id, 'recovery-1', 1_000);
    expect(fire).toBeDefined();
    const firstClaim = claimNextAutomationFire({
      workerId: 'worker-before-restart',
      leaseMs: 100,
      concurrencyCap: 1,
      fireId: fire!.id,
      nowMs: 1_000,
    });
    expect(firstClaim).toBeDefined();
    const precheck = await ensureAutomationPrecheck(firstClaim!, () => 1_010);
    expect(precheck.action).toBe('continue');
    expect(getAutomationFire(fire!.id)?.precheckStatus).toBe('passed');

    expect(recoverExpiredAutomationFires(1_101)).toBe(1);
    const recovered = claimNextAutomationFire({
      workerId: 'worker-after-restart',
      leaseMs: 100,
      concurrencyCap: 1,
      fireId: fire!.id,
      nowMs: 1_101,
    });
    expect(recovered).toBeDefined();
    await expect(runClaimedAutomationFire(recovered!, () => 1_120)).resolves.toMatchObject({
      status: 'succeeded',
      precheckStatus: 'passed',
      recoveryCount: 1,
    });
    expect(readFileSync(markerPath, 'utf8')).toBe('x');
    expect(runAutomation).toHaveBeenCalledTimes(1);
  });

  it('uses the configured repository context, bounds multibyte output, and kills the timed-out process tree', async () => {
    const bounded = await runBoundedAutomationPrecheck({
      command: nodeCommand("process.stdout.write(process.cwd()); process.stderr.write('é'.repeat(10000))"),
      cwd: repoPath,
      timeoutMs: 10_000,
    });
    expect(bounded).toMatchObject({ status: 'passed', exitCode: 0, stdoutTail: realpathSync(repoPath) });
    expect(Buffer.byteLength(bounded.stderrTail, 'utf8')).toBeLessThanOrEqual(8 * 1024);

    const missingContext = await runBoundedAutomationPrecheck({
      command: nodeCommand("process.stdout.write('unreachable')"),
      cwd: join(repoPath, 'missing-directory'),
      timeoutMs: 10_000,
    });
    expect(missingContext.status).toBe('error');
    expect(missingContext.errorMessage).toContain('Precheck spawn failed:');

    const markerPath = join(repoPath, 'timed-out-child.txt');
    const childScript = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(markerPath)}, 'leaked'), 1400)`;
    const parentScript = [
      "const { spawn } = require('child_process')",
      `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' })`,
      'setInterval(() => {}, 60_000)',
    ].join(';');
    const timedOut = await runBoundedAutomationPrecheck({
      command: nodeCommand(parentScript),
      cwd: repoPath,
      timeoutMs: 1_000,
    });
    expect(timedOut.status).toBe('error');
    expect(timedOut.errorMessage).toContain('timed out');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(existsSync(markerPath)).toBe(false);
  });
});
