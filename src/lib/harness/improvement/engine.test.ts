import { describe, expect, it } from 'vitest';
import { createExperiment, advanceExperiment, settleExperiment, validatePersistedExperiment } from './engine';
import { digest } from './validation';
import type { ImprovementExperiment, ImprovementManifest, ImprovementReceipt, ImprovementRequest } from './types';

const input = (): ImprovementManifest => ({
  id: 'trial', repository: 'repo', baselineRevision: 'a'.repeat(40),
  contractDigest: 'b'.repeat(64), verifierDigest: 'c'.repeat(64), permissionsDigest: 'd'.repeat(64),
  runtime: 'codex', model: 'test-model', effort: 'high', provenance: 'fixture', mode: 'parallel', k: 2,
  maxStages: 40, maxStageWallMs: 1000, maxInputBytes: 100000,
  baseline: { instructions: 'Keep safety and review boundaries.' },
  tasks: [{ id: 'A', domain: 'code', prompt: 'Implement A.' }, { id: 'B', domain: 'code', prompt: 'Implement B.' }],
});
function result(request: ImprovementRequest): ImprovementReceipt {
  const receipt: ImprovementReceipt = {
    requestId: request.id, requestDigest: digest(request), status: 'completed', provenance: 'fixture',
    runtime: 'codex', model: 'test-model', effort: 'high',
    usage: { attempts: 1, inputTokens: null, outputTokens: null, actualUsd: null, estimatedUsd: null,
      wallMs: 1, humanMs: null, billing: 'unknown' },
  };
  if (request.kind === 'execute') Object.assign(receipt, { artifact: `artifact ${request.label}`, trajectory: 'observable work' });
  else if (request.kind === 'select') receipt.choice = request.choices[0]?.id;
  else if (request.kind === 'reflect') receipt.lesson = {
    text: 'Check error paths before emitting a patch.', sourceRequestIds: [request.evidence.find((row) => row.label.startsWith('baseline'))!.requestId, request.evidence.find((row) => !row.label.startsWith('baseline'))!.requestId], expiresAfterTask: 5,
  };
  else receipt.harness = { instructions: `${request.harness.instructions}\n${request.label} learned edit` };
  if (request.kind === 'compose') receipt.decisions = [{ action: 'revise', rationale: 'Fixture contrast, not live evidence.',
    sourceRequestIds: [request.evidence.find((row) => row.label.startsWith('baseline'))!.requestId,
      request.evidence.find((row) => !row.label.startsWith('baseline'))!.requestId] }];
  return receipt;
}
function noncompleted(receipt: ImprovementReceipt, status: 'failed' | 'uncertain'): ImprovementReceipt {
  const { harness: _h, artifact: _a, trajectory: _t, choice: _c, decisions: _d, lesson: _l, ...observation } = receipt;
  return { ...observation, status };
}
function run(config = input(), inspect: (request: ImprovementRequest) => void = () => {}): ImprovementExperiment {
  let state = createExperiment(config);
  for (let i = 0; i < 100; i += 1) {
    state = advanceExperiment(state);
    if (state.status !== 'pending') return state;
    inspect(state.pending!);
    state = settleExperiment(state, result(state.pending!));
    // Every transition is JSON-safe across a process restart, not closure state.
    state = JSON.parse(JSON.stringify(state)) as ImprovementExperiment;
    validatePersistedExperiment(state);
  }
  throw new Error('Scheduler did not terminate.');
}

describe('bounded refinement scheduler (fixture protocol, not live efficacy)', () => {
  it('starts with the common baseline and does not mutate its caller', () => {
    const state = createExperiment(input());
    const pending = advanceExperiment(state);
    expect(pending.pending?.kind).toBe('execute');
    expect(pending.pending?.label).toBe('baseline');
    expect(pending.pending?.harness).toEqual(state.manifest.baseline);
    expect(state.pending).toBe(null);
    expect(pending.acceptance.liveBenefitProven).toBe(false);
  });
  it.each(['parallel', 'sequential'] as const)('schedules all %s k=2 stages and fresh successor executions', (mode) => {
    const state = run({ ...input(), mode });
    expect(state.status).toBe('completed');
    for (const task of ['A', 'B']) {
      const records = state.records.filter((row) => row.request.taskId === task);
      expect(records).toHaveLength(16); // 4k executions + 3k improver turns + selector + reflector.
      expect(records.filter((row) => row.request.kind === 'execute')).toHaveLength(8);
      for (const label of ['composed1', 'composed2']) {
        const edit = records.find((row) => row.request.kind === 'compose' && row.request.label === label)!;
        const execution = records.find((row) => row.request.kind === 'execute' && row.request.label === label)!;
        expect(execution.request.harness).toEqual(edit.receipt.harness);
        expect(execution.request.id).not.toBe(edit.request.id);
        expect(records.indexOf(execution)).toBeGreaterThan(records.indexOf(edit));
      }
    }
    expect(state.acceptance).toEqual({ liveBenefitProven: false, promoted: false });
  });
  it('parallel candidates share only baseline evidence and compositions are independent', () => {
    run(input(), (request) => {
      if (request.kind.startsWith('propose_')) {
        expect(request.evidence.every((row) => row.label.startsWith('baseline'))).toBe(true);
        expect(request.harness).toEqual(input().baseline);
      }
      if (request.kind === 'compose') {
        expect(request.evidence).toHaveLength(6);
        expect(request.evidence.some((row) => row.label.startsWith('composed'))).toBe(false);
        expect(request.harness).toEqual(input().baseline);
      }
    });
  });
  it('sequential round two receives the preceding successor and observed contrasts', () => {
    run({ ...input(), mode: 'sequential' }, (request) => {
      if (request.kind === 'propose_domain' && request.label === 'dom2') {
        expect(request.harness.instructions).toContain('composed1 learned edit');
        expect(request.evidence.some((row) => row.label === 'composed1')).toBe(true);
      }
    });
  });
  it('retrieves A lessons for B improver after restart but starts B with common baseline', () => {
    run(input(), (request) => {
      if (request.taskId === 'A') expect(request.lessons).toHaveLength(0);
      if (request.taskId === 'B' && request.kind === 'propose_domain') {
        expect(request.lessons).toHaveLength(1);
        expect(request.lessons[0]?.sourceTaskId).toBe('A');
      }
      if (request.taskId === 'B' && request.kind === 'execute' && request.label === 'baseline') {
        expect(request.harness).toEqual(input().baseline);
        expect(request.lessons).toHaveLength(0);
      }
    });
  });
  it('does not retrieve another domain or inject lessons into probes/selectors', () => {
    const config = input(); config.tasks[1]!.domain = 'different';
    run(config, (request) => {
      if (request.taskId === 'B' || request.kind === 'execute' || request.kind === 'select') expect(request.lessons).toHaveLength(0);
    });
  });
  it('blinds selector metadata and retains only an existing output', () => {
    const state = run(input(), (request) => {
      if (request.kind !== 'select') return;
      expect(request.evidence).toEqual([]);
      expect(request.choices).toHaveLength(4);
      expect(Object.keys(request.choices[0]!)).toEqual(['id', 'artifact']);
    });
    expect(state.selections.every((selection) => state.records.some((row) => row.request.id === selection.requestId && row.request.kind === 'execute'))).toBe(true);
  });
  it('refuses unknown schema fields including supplied grading results', () => {
    expect(() => createExperiment({ ...input(), score: 1 } as ImprovementManifest)).toThrow();
    const state = advanceExperiment(createExperiment(input()));
    expect(() => settleExperiment(state, { ...result(state.pending!), score: 1 } as ImprovementReceipt)).toThrow();
  });
  it('rejects stale request digests and effective model drift', () => {
    const state = advanceExperiment(createExperiment(input()));
    expect(() => settleExperiment(state, { ...result(state.pending!), requestDigest: 'stale' })).toThrow('bind');
    expect(() => settleExperiment(state, { ...result(state.pending!), model: 'other' })).toThrow('frozen');
  });
  it('never relaunches an uncertain pending operation', () => {
    const state = advanceExperiment(createExperiment(input()));
    const blocked = settleExperiment(state, noncompleted(result(state.pending!), 'uncertain'));
    expect(blocked.status).toBe('blocked');
    expect(advanceExperiment(blocked).pending?.id).toBe(state.pending?.id);
    expect(advanceExperiment(blocked).revision).toBe(blocked.revision);
  });
  it('enforces stage budget without launching another turn', () => {
    const state = run({ ...input(), maxStages: 2 });
    expect(state.records).toHaveLength(2);
    expect(state.pending).toBe(null);
    expect(state.blockedReason).toBe('stage_budget_exhausted');
  });
  it('uses UTF-8 input byte bounds and refuses instead of truncating evidence', () => {
    const config = input(); config.maxInputBytes = 1024; config.tasks[0]!.prompt = 'é'.repeat(600);
    expect(advanceExperiment(createExperiment(config)).blockedReason).toBe('context_budget_exhausted');
  });
  it('does not let a failed proposal supply an effective edited harness', () => {
    let state = createExperiment({ ...input(), k: 1 });
    for (let i = 0; i < 5; i += 1) {
      state = advanceExperiment(state);
      if (state.pending!.kind === 'execute' && state.pending!.label === 'inv1') {
        expect(state.pending!.harness).toEqual(input().baseline); return;
      }
      const receipt = result(state.pending!);
      state = settleExperiment(state, state.pending!.kind === 'propose_invariant' ? noncompleted(receipt, 'failed') : receipt);
    }
    throw new Error('Missing candidate probe');
  });
  it('refuses mutation of a frozen manifest', () => {
    const state = createExperiment(input()); state.manifest.baselineRevision = 'f'.repeat(40);
    expect(() => advanceExperiment(state)).toThrow('binding');
  });
});

describe('uncertain receipt accounting', () => {
  it('retains uncertainty and reconciles the same reservation without duplicate attempts', async () => {
    const { improvementAccounting } = await import('./accounting');
    const pending = advanceExperiment(createExperiment(input()));
    const receipt = result(pending.pending!);
    receipt.usage.actualUsd = 0.03;
    const blocked = settleExperiment(pending, noncompleted(receipt, 'uncertain'));
    expect(blocked.pendingReceipt?.usage.actualUsd).toBe(0.03);
    expect(improvementAccounting(blocked).actualUsd.total).toBe(0.03);
    const settled = settleExperiment(blocked, receipt);
    expect(settled.records).toHaveLength(1);
    expect(settled.pendingReceipt).toBe(null);
    expect(improvementAccounting(settled).observedAttempts).toBe(1);
  });
  it('keeps unknown actual cost separate from estimates and subscription usage', async () => {
    const { improvementAccounting } = await import('./accounting');
    const pending = advanceExperiment(createExperiment(input()));
    const receipt = result(pending.pending!);
    receipt.usage.billing = 'subscription'; receipt.usage.estimatedUsd = 2;
    const summary = improvementAccounting(settleExperiment(pending, receipt));
    expect(summary.actualUsd.total).toBe(null);
    expect(summary.estimatedUsd.total).toBe(2);
    expect(summary.billingModes).toEqual(['subscription']);
    expect(summary.allInComplete).toBe(false);
  });
});


describe('supported artifacts and persisted-state replay', () => {
  it('retains adopted harness content and digest with every lesson', () => {
    const state = run();
    expect(state.lessons).toHaveLength(2);
    for (const lesson of state.lessons) expect(lesson.adoptedHarnessDigest).toBe(digest(lesson.adoptedHarness));
  });
  it('rejects poisoned pending requests, receipts, lessons and selections', () => {
    const pending = advanceExperiment(createExperiment(input()));
    pending.pending!.harness.instructions = 'poison';
    expect(() => validatePersistedExperiment(pending)).toThrow();
    for (const key of ['lessons', 'selections', 'records'] as const) {
      const state = run();
      (state[key][0] as unknown as Record<string, unknown>).injected = true;
      expect(() => validatePersistedExperiment(state)).toThrow();
    }
  });
  it('holds instead of adapting when every baseline failed', () => {
    let state = createExperiment(input());
    for (let i = 0; i < 2; i += 1) {
      state = advanceExperiment(state);
      state = settleExperiment(state, noncompleted(result(state.pending!), 'failed'));
    }
    expect(advanceExperiment(state).blockedReason).toBe('no_completed_reference');
  });
});


it('cannot forge zero-work completion by moving the task cursor', () => {
  const state = createExperiment(input()); state.taskIndex = state.manifest.tasks.length;
  expect(() => advanceExperiment(state)).toThrow('Stored experiment');
});

it('rejects fixture/native mixing even with matching runtime declarations', () => {
  const state = advanceExperiment(createExperiment(input()));
  expect(() => settleExperiment(state, { ...result(state.pending!), provenance: 'native' })).toThrow(/provenance/);
});

it('records spent malformed terminal attempts without relaunching or losing usage', async () => {
  const { ingestTerminalOutput } = await import('./ingest');
  const state = advanceExperiment(createExperiment(input()));
  const { artifact: _artifact, trajectory: _trajectory, status: _status, ...observation } = result(state.pending!);
  const rejected = ingestTerminalOutput(state, observation, { harness: { instructions: 'wrong stage' } });
  expect(rejected.records[0].receipt.status).toBe('failed');
  expect(rejected.records[0].receipt.failureReason).toBe('invalid_stage_output');
  expect(rejected.records[0].receipt.usage).toEqual(observation.usage);
  expect(rejected.pending).toBeNull();
  validatePersistedExperiment(rejected);
  expect(() => ingestTerminalOutput(state, { ...observation, model: 'drift' }, {})).toThrow(/frozen/);
});

it('cannot erase prior observed spend when reconciling uncertainty', () => {
  const state = advanceExperiment(createExperiment(input()));
  const receipt = result(state.pending!); receipt.usage.actualUsd = 0.03;
  const uncertain = settleExperiment(state, noncompleted(receipt, 'uncertain'));
  expect(() => settleExperiment(uncertain, { ...receipt, usage: { ...receipt.usage, actualUsd: 0 } })).toThrow(/erase/);
});
it('does not report an outstanding unobserved reservation as free', async () => {
  const { improvementAccounting } = await import('./accounting');
  const pending = advanceExperiment(createExperiment(input()));
  expect(improvementAccounting(pending).actualUsd.total).toBeNull();
  expect(improvementAccounting(pending).unobservedReservations).toBe(1);
});

describe('append-only permanent lesson revocation', () => {
  function afterFirstTask(): ImprovementExperiment {
    let state = createExperiment({ ...input(), k: 1 });
    while (state.taskIndex === 0) {
      state = advanceExperiment(state);
      state = settleExperiment(state, result(state.pending!));
    }
    return state;
  }

  it('replays a bounded revocation event and excludes that lesson from the next task after restart', async () => {
    const { revokeExperimentLesson } = await import('./engine');
    const original = afterFirstTask(); const lesson = original.lessons[0]!;
    const revoked = revokeExperimentLesson(original, lesson.id, 'The observation does not generalize.');
    expect(original.lessons[0]!.revoked).toBe(false);
    expect(revoked.records).toEqual(original.records);
    expect(revoked.revision).toBe(original.revision + 1);
    expect(revoked.lessonRevocations).toEqual([{ lessonId: lesson.id, lessonDigest: digest(lesson),
      scopeDigest: original.scopeDigest, afterRecordCount: original.records.length, reason: 'The observation does not generalize.' }]);
    expect(revoked.lessons[0]!.revoked).toBe(true);
    let restored = JSON.parse(JSON.stringify(revoked)) as ImprovementExperiment;
    validatePersistedExperiment(restored);
    restored = advanceExperiment(restored);
    expect(restored.pending!.label).toBe('baseline');
    restored = settleExperiment(restored, result(restored.pending!));
    restored = advanceExperiment(restored);
    expect(restored.pending!.kind).toBe('propose_invariant');
    expect(restored.pending!.lessons).toEqual([]);
    expect(restored.acceptance).toEqual({ liveBenefitProven: false, promoted: false });
  });

  it('preserves earlier requests that consumed a lesson while excluding it from later requests', async () => {
    const { revokeExperimentLesson } = await import('./engine');
    let state = afterFirstTask();
    state = advanceExperiment(state); state = settleExperiment(state, result(state.pending!));
    state = advanceExperiment(state);
    expect(state.pending!.lessons).toHaveLength(1);
    state = settleExperiment(state, result(state.pending!));
    const historical = structuredClone(state.records);
    state = revokeExperimentLesson(state, state.lessons[0]!.id, 'Contradictory observation found.');
    expect(state.records).toEqual(historical);
    expect(state.records.at(-1)!.request.lessons[0]!.revoked).toBe(false);
    validatePersistedExperiment(state);
    state = advanceExperiment(state);
    expect(state.pending!.kind).toBe('propose_domain');
    expect(state.pending!.lessons).toEqual([]);
    validatePersistedExperiment(state);
  });

  it('defines exact repeat as a no-op without rewriting the reason or appending duplicates', async () => {
    const { revokeExperimentLesson } = await import('./engine');
    const state = afterFirstTask(); const id = state.lessons[0]!.id;
    const revoked = revokeExperimentLesson(state, id, 'Retract this lesson.');
    expect(revokeExperimentLesson(revoked, id, 'Retract this lesson.')).toEqual(revoked);
    expect(() => revokeExperimentLesson(revoked, id, 'Rewrite the reason.')).toThrow(/already|reason|revoked/i);
    expect(() => revokeExperimentLesson(state, 'unknown-lesson', 'Unknown lesson.')).toThrow(/lesson/i);
    expect(() => revokeExperimentLesson(state, id, 'x'.repeat(4097))).toThrow();
    const duplicate = structuredClone(revoked);
    duplicate.lessonRevocations.push(structuredClone(duplicate.lessonRevocations[0]!));
    expect(() => validatePersistedExperiment(duplicate)).toThrow();
  });

  it('rejects direct booleans, forged scope/content bindings and backdated or removed events', async () => {
    const { revokeExperimentLesson } = await import('./engine');
    const state = afterFirstTask(); const raw = structuredClone(state);
    raw.lessons[0]!.revoked = true;
    expect(() => validatePersistedExperiment(raw)).toThrow();
    const revoked = revokeExperimentLesson(state, state.lessons[0]!.id, 'Withdraw unsupported generalization.');
    for (const change of [
      { scopeDigest: 'f'.repeat(64) }, { lessonDigest: 'f'.repeat(64) }, { afterRecordCount: 0 },
      { afterRecordCount: state.records.length + 1 }, { lessonId: 'f'.repeat(64) }, { extra: 'poison' },
    ]) {
      const forged = structuredClone(revoked);
      Object.assign(forged.lessonRevocations[0]!, change);
      expect(() => validatePersistedExperiment(forged)).toThrow();
    }
    const restored = structuredClone(revoked); restored.lessons[0]!.revoked = false;
    expect(() => validatePersistedExperiment(restored)).toThrow();
    const removed = structuredClone(revoked); removed.lessonRevocations = [];
    expect(() => validatePersistedExperiment(removed)).toThrow();
  });

  it('replays two revocations at one boundary and rejects decreasing event positions', async () => {
    const { revokeExperimentLesson } = await import('./engine');
    let state = afterFirstTask();
    const firstLesson = state.lessons[0]!.id;
    while (state.taskIndex === 1) {
      state = advanceExperiment(state); state = settleExperiment(state, result(state.pending!));
    }
    const secondLesson = state.lessons[1]!.id;
    state = revokeExperimentLesson(state, firstLesson, 'Withdraw first lesson.');
    state = revokeExperimentLesson(state, secondLesson, 'Withdraw second lesson.');
    expect(state.lessonRevocations.map((event) => event.afterRecordCount)).toEqual([state.records.length, state.records.length]);
    expect(state.lessons.every((lesson) => lesson.revoked)).toBe(true);
    validatePersistedExperiment(state);
    const completed = advanceExperiment(state);
    expect(completed.status).toBe('completed');
    expect(() => revokeExperimentLesson(completed, firstLesson, 'Withdraw first lesson.')).toThrow(/ready/i);
    const forged = structuredClone(state);
    forged.lessonRevocations[1]!.afterRecordCount = 1;
    expect(() => validatePersistedExperiment(forged)).toThrow();
  });

  it('cannot revoke while a request is reserved or an unknown outcome is blocked', async () => {
    const { revokeExperimentLesson } = await import('./engine');
    const state = afterFirstTask(); const id = state.lessons[0]!.id;
    const pending = advanceExperiment(state);
    expect(() => revokeExperimentLesson(pending, id, 'Do not alter pending requests.')).toThrow(/ready|pending|reserved/i);
    const uncertain = settleExperiment(pending, noncompleted(result(pending.pending!), 'uncertain'));
    expect(() => revokeExperimentLesson(uncertain, id, 'Do not bypass reconciliation.')).toThrow(/ready|pending|blocked/i);
    expect(advanceExperiment(uncertain)).toEqual(uncertain);
    expect(uncertain.pending!.id).toBe(pending.pending!.id);
  });
});
