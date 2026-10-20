import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { createImprovementJournal } from '@/lib/harness/improvement/journal';
import { advanceExperiment, settleExperiment } from '@/lib/harness/improvement/engine';
import { digest } from '@/lib/harness/improvement/validation';
import type { ImprovementExperiment, ImprovementManifest } from '@/lib/harness/improvement/types';
import type { HarnessContract } from '@/lib/harness/types';

const root = mkdtempSync(join(realpathSync(tmpdir()), 'o8-refinement-service-'));
const dataDir = join(root, 'data'); mkdirSync(dataDir, { mode: 0o700 });
const repoDir = join(root, 'repository');
const otherRepo = join(root, 'other-repository');
const priorData = process.env.CORTEX_IDE_DATA_DIR;
const priorO8Data = process.env.O8_DATA_DIR;
const operatorToken = 'refinement-fixture-operator-0123456789abcdef';
writeFileSync(join(dataDir, 'ws-token'), `${operatorToken}\n`, { mode: 0o600 });
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

function initRepo(path: string): void {
  execFileSync('git', ['init', '-b', 'main', path], { stdio: 'pipe' });
  execFileSync('git', ['-C', path, 'config', 'user.email', 'fixture@example.invalid']);
  execFileSync('git', ['-C', path, 'config', 'user.name', 'Refinement Fixture']);
  writeFileSync(join(path, 'AGENTS.md'), 'Preserve review and permission boundaries.\n');
  writeFileSync(join(path, 'fixture.ts'), 'export const fixture = true;\n');
  execFileSync('git', ['-C', path, 'add', 'AGENTS.md', 'fixture.ts']);
  execFileSync('git', ['-C', path, 'commit', '-m', 'Initialize isolated fixture'], { stdio: 'pipe' });
}
initRepo(repoDir); initRepo(otherRepo);
const head = execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const { POST } = await import('@/app/api/harness/route');
const { closeDb } = await import('@/lib/db');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const { listLanes } = await import('@/lib/lane/registry');

function request(body: Record<string, unknown>, token: string | null = operatorToken): NextRequest {
  return new NextRequest('http://localhost/api/harness', {
    method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });
}
async function post<T>(body: Record<string, unknown>): Promise<T> {
  const response = await POST(request(body));
  const payload = await response.json();
  expect(response.status, JSON.stringify(payload)).toBe(200);
  expect(payload.ok).toBe(true);
  return payload.result as T;
}
async function contract(accept = true): Promise<HarnessContract> {
  const proposed = await post<HarnessContract>({ action: 'contract_propose', repoPath: repoDir,
    generatorTerms: 'Modify only the disposable fixture.', evaluatorTerms: 'Inspect isolated fixture behavior.',
    acceptanceCriteria: ['Fixture changes preserve all immutable policy boundaries.'] });
  return accept ? post<HarnessContract>({ action: 'contract_transition', repoPath: repoDir,
    contractId: proposed.id, status: 'accepted' }) : proposed;
}
function manifest(id: string, accepted: HarnessContract): ImprovementManifest {
  return {
    id, repository: realpathSync(repoDir), baselineRevision: head, contractDigest: digest(accepted),
    verifierDigest: 'b'.repeat(64), permissionsDigest: 'c'.repeat(64), runtime: 'codex',
    model: 'fixture-model', effort: 'high', provenance: 'fixture', mode: 'parallel', k: 1,
    maxStages: 9, maxStageWallMs: 1000, maxInputBytes: 100000,
    baseline: { instructions: 'Do not alter authorization or verification boundaries.' },
    tasks: [{ id: 'A', domain: 'code', prompt: 'Inspect the isolated fixture.' }],
  };
}
function prepareBody(input: ImprovementManifest, accepted: HarnessContract): Record<string, unknown> {
  return { action: 'refinement_prepare', repoPath: repoDir, contractId: accepted.id, manifest: input };
}
function journalContents(): Record<string, string> {
  const path = join(dataDir, 'harness-refinement');
  if (!existsSync(path)) return {};
  const files: Record<string, string> = {};
  for (const id of readdirSync(path)) for (const entry of readdirSync(join(path, id))) {
    files[`${id}/${entry}`] = readFileSync(join(path, id, entry), 'utf8');
  }
  return files;
}

afterAll(() => {
  closeDb();
  if (priorData === undefined) delete process.env.CORTEX_IDE_DATA_DIR; else process.env.CORTEX_IDE_DATA_DIR = priorData;
  if (priorO8Data === undefined) delete process.env.O8_DATA_DIR; else process.env.O8_DATA_DIR = priorO8Data;
  rmSync(root, { recursive: true, force: true });
});

describe.sequential('refinement preparation through the authenticated harness route and actual persisted state', () => {
  it('prepares an accepted pinned experiment and retrieves it after closing database connections', async () => {
    const accepted = await contract(); const input = manifest('route-persisted', accepted);
    const prepared = await post<{ state: ImprovementExperiment; launch: string }>(prepareBody(input, accepted));
    expect(prepared.launch).toBe('held');
    expect(prepared.state).toMatchObject({ revision: 0, status: 'ready', manifest: input,
      pending: null, records: [], acceptance: { liveBenefitProven: false, promoted: false } });
    expect(Object.keys(journalContents())).toContain(`${digest(input.id)}/000000.json`);
    closeDb();
    const restored = await post<{ state: ImprovementExperiment; launch: string; accounting: { allInComplete: boolean } }>({
      action: 'refinement_status', repoPath: repoDir, id: input.id,
    });
    expect(restored.state).toEqual(prepared.state);
    expect(restored.launch).toBe('held');
    expect(restored.accounting.allInComplete).toBe(false);
    const duplicate = await POST(request(prepareBody(input, accepted)));
    expect(duplicate.status).toBe(400);
    expect((await post<{ state: ImprovementExperiment }>({ action: 'refinement_status', repoPath: repoDir, id: input.id })).state)
      .toEqual(prepared.state);
  });

  it('requires an accepted contract and rejects missing or mismatched contract, repo and baseline pins', async () => {
    const proposed = await contract(false); const accepted = await contract();
    const bodies = [
      prepareBody(manifest('not-accepted', proposed), proposed),
      { ...prepareBody(manifest('missing-contract', accepted), accepted), contractId: 'missing' },
      prepareBody({ ...manifest('wrong-digest', accepted), contractDigest: 'f'.repeat(64) }, accepted),
      prepareBody({ ...manifest('wrong-base', accepted), baselineRevision: 'f'.repeat(40) }, accepted),
      prepareBody({ ...manifest('wrong-repo', accepted), repository: realpathSync(otherRepo) }, accepted),
      { ...prepareBody(manifest('wrong-request-repo', accepted), accepted), repoPath: otherRepo },
    ];
    const before = journalContents();
    for (const body of bodies) {
      const response = await POST(request(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'harness_action_failed' } });
    }
    expect(journalContents()).toEqual(before);
  });

  it('keeps all refinement actions operator-only with real packet-worker and anonymous credentials', async () => {
    const accepted = await contract(); const input = manifest('worker-refused', accepted);
    const workerToken = mintPacketWorkerToken('refinement-fixture-worker');
    const before = journalContents();
    for (const body of [prepareBody(input, accepted), { action: 'refinement_status', repoPath: repoDir, id: 'route-persisted' },
      { action: 'refinement_launch', repoPath: repoDir, id: 'route-persisted' }]) {
      const worker = await POST(request(body, workerToken));
      expect(worker.status).toBe(403);
      expect(await worker.json()).toMatchObject({ ok: false, error: { code: 'operator_required' } });
      const anonymous = await POST(request(body, null));
      expect(anonymous.status).toBe(403);
      expect(await anonymous.json()).toMatchObject({ ok: false, error: { code: 'operator_or_worker_required' } });
    }
    expect(journalContents()).toEqual(before);
  });

  it('cannot read an experiment through a different repository', async () => {
    const response = await POST(request({ action: 'refinement_status', repoPath: otherRepo, id: 'route-persisted' }));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'harness_action_failed' } });
  });

  it('refuses operator launch for fixture and declared-native manifests without admitting a lane, sprint or request', async () => {
    const accepted = await contract();
    for (const provenance of ['fixture', 'native'] as const) {
      const input = { ...manifest(`launch-${provenance}`, accepted), provenance };
      const prepared = await post<{ state: ImprovementExperiment }>(prepareBody(input, accepted));
      const before = journalContents(); const lanes = listLanes();
      const sprints = await post({ action: 'sprint_list', repoPath: repoDir });
      const response = await POST(request({ action: 'refinement_launch', repoPath: repoDir, id: input.id, approved: true }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'harness_action_failed' } });
      expect(journalContents()).toEqual(before);
      expect(listLanes()).toEqual(lanes);
      expect(await post({ action: 'sprint_list', repoPath: repoDir })).toEqual(sprints);
      const after = await post<{ state: ImprovementExperiment; launch: string }>({ action: 'refinement_status', repoPath: repoDir, id: input.id });
      expect(after.state).toEqual(prepared.state);
      expect(after.state.pending).toBeNull(); expect(after.state.records).toEqual([]);
      expect(after.launch).toBe('held');
    }
  });
  it('revokes a fixture-supported lesson through operator route with revision CAS and persisted replay', async () => {
    const accepted = await contract();
    const input = { ...manifest('route-revoke', accepted), maxStages: 18,
      tasks: [{ id: 'A', domain: 'code', prompt: 'Fixture A' }, { id: 'B', domain: 'code', prompt: 'Fixture B' }] };
    let state = (await post<{ state: ImprovementExperiment }>(prepareBody(input, accepted))).state;
    const journal = createImprovementJournal(join(dataDir, 'harness-refinement'));
    while (state.taskIndex === 0) {
      const reserved = advanceExperiment(state); journal.append(reserved, state.revision);
      const pending = reserved.pending!;
      const sources = pending.evidence.slice(0, 2).map((row) => row.requestId);
      const output = pending.kind === 'execute' ? { artifact: 'Fixture output' }
        : pending.kind === 'select' ? { choice: pending.choices[0].id }
          : pending.kind === 'reflect' ? { lesson: { text: 'Fixture contrast', sourceRequestIds: sources, expiresAfterTask: 2 } }
            : pending.kind === 'compose' ? { harness: pending.harness, decisions: [{ action: 'preserve' as const,
              rationale: 'Fixture preserves baseline.', sourceRequestIds: sources }] } : { harness: pending.harness };
      state = settleExperiment(reserved, { requestId: pending.id, requestDigest: digest(pending), status: 'completed',
        provenance: 'fixture', runtime: input.runtime, model: input.model, effort: input.effort, ...output,
        usage: { attempts: 1, inputTokens: null, outputTokens: null, actualUsd: null, estimatedUsd: null,
          wallMs: 1, humanMs: null, billing: 'unknown' } });
      journal.append(state, reserved.revision);
    }
    const body = { action: 'refinement_revoke_lesson', repoPath: repoDir, id: input.id,
      expectedRevision: state.revision, lessonId: state.lessons[0].id, reason: 'Operator withdraws fixture lesson.' };
    expect((await POST(request(body, mintPacketWorkerToken('revoke-worker')))).status).toBe(403);
    const revoked = await post<{ state: ImprovementExperiment }>(body);
    expect(revoked.state.lessons[0].revoked).toBe(true);
    expect(revoked.state.lessonRevocations).toHaveLength(1);
    closeDb();
    expect((await post<{ state: ImprovementExperiment }>({ action: 'refinement_status', repoPath: repoDir, id: input.id })).state)
      .toEqual(revoked.state);
    expect((await POST(request(body))).status).toBe(400);
  });

  it('reserves without launch and refuses packet preparation in the ordinary app namespace', async () => {
    const accepted = await contract(); const input = { ...manifest('route-reserve', accepted), provenance: 'native' as const };
    await post(prepareBody(input, accepted));
    const reserved = await post<{ state: ImprovementExperiment; launch: string }>({ action: 'refinement_reserve_next',
      repoPath: repoDir, id: input.id, expectedRevision: 0 });
    expect(reserved.launch).toBe('held'); expect(reserved.state.pending?.kind).toBe('execute');
    const before = journalContents(); const lanes = listLanes();
    const body = { action: 'refinement_prepare_packet', repoPath: repoDir, id: input.id,
      requestId: reserved.state.pending!.id, expectedRevision: reserved.state.revision };
    expect((await POST(request(body))).status).toBe(400);
    expect(journalContents()).toEqual(before); expect(listLanes()).toEqual(lanes);
    expect((await POST(request(body, mintPacketWorkerToken('prepare-worker')))).status).toBe(403);
  });

});
