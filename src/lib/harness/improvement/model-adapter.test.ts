import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorBackend, OrchestratorTurnOptions } from '@/lib/lane/orchestrator-backends/types';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import { advanceExperiment, createExperiment, settleExperiment } from './engine';
import { digest } from './validation';
import { createNativeModelStageAdapter, type NativeModelStageConfinement, type NativeModelStageGrant,
  type NativeModelStageIntent } from './model-adapter';
import type { ImprovementExperiment, ImprovementManifest, ImprovementReceipt, ImprovementRequest, ImprovementStageKind } from './types';

const registry = vi.hoisted(() => ({ getOrchestratorBackend: vi.fn() }));
vi.mock('@/lib/lane/orchestrator-backends/registry', () => registry);

// All native-shaped observations in this file are protocol fixtures. No provider,
// subprocess, credential, native provenance evidence, or efficacy claim is involved.
const manifest = (): ImprovementManifest => ({
  id: 'protocol', repository: '/isolated/protocol-repo', baselineRevision: 'a'.repeat(40),
  contractDigest: 'b'.repeat(64), verifierDigest: 'c'.repeat(64), permissionsDigest: 'd'.repeat(64),
  runtime: 'codex', model: 'test-model', effort: 'high', provenance: 'native', mode: 'parallel', k: 1,
  maxStages: 20, maxStageWallMs: 1000, maxInputBytes: 100000,
  baseline: { instructions: 'HARNESS_IDENTITY_DO_NOT_SHOW_SELECTOR' },
  tasks: [{ id: 'A', domain: 'code', prompt: 'Return an artifact.' }],
});
function payload(request: ImprovementRequest): Record<string, unknown> {
  if (request.kind === 'execute') return { artifact: `artifact ${request.id}`, trajectory: 'TRAJECTORY_DO_NOT_SHOW_SELECTOR' };
  if (request.kind === 'select') return { choice: request.choices[0]!.id };
  const sourceRequestIds = [request.evidence.find((row) => row.label.startsWith('baseline'))?.requestId,
    request.evidence.find((row) => !row.label.startsWith('baseline'))?.requestId];
  if (request.kind === 'reflect') return { lesson: { text: 'Protocol observation only.', sourceRequestIds, expiresAfterTask: 3 } };
  return { harness: request.harness, ...(request.kind === 'compose'
    ? { decisions: [{ action: 'preserve', rationale: 'Protocol contrast only.', sourceRequestIds }] } : {}) };
}
function protocolState(kind: ImprovementStageKind = 'propose_invariant', overrides: Partial<ImprovementManifest> = {}): ImprovementExperiment {
  let state = advanceExperiment(createExperiment({ ...manifest(), ...overrides }));
  for (let n = 0; n < 20; n += 1) {
    const request = state.pending!;
    if (request.kind === kind) return state;
    const fixture = { requestId: request.id, requestDigest: digest(request), status: 'completed',
      provenance: state.manifest.provenance, runtime: state.manifest.runtime, model: state.manifest.model, effort: state.manifest.effort,
      usage: { attempts: 1, inputTokens: null, outputTokens: null, actualUsd: null, estimatedUsd: null,
        wallMs: 1, humanMs: null, billing: 'unknown' }, ...payload(request) } as ImprovementReceipt;
    state = advanceExperiment(settleExperiment(state, fixture));
  }
  throw new Error('Missing protocol stage.');
}
function grant(intent: NativeModelStageIntent): NativeModelStageGrant {
  return { approved: true, approvalId: 'protocol-approval', reservationId: 'protocol-reservation',
    intentDigest: digest(intent), expiresAt: Date.now() + 100000 };
}
function confinement(intent: NativeModelStageIntent): NativeModelStageConfinement {
  return { intentDigest: digest(intent), attestationId: 'protocol-isolation', repository: intent.repository,
    hiddenEvaluationInaccessible: true, credentialsInaccessibleToTools: true, ambientContextDisabled: true,
    readOnly: true, expiresAt: Date.now() + 100000 };
}
const done: OrchestratorEvent = { type: 'done', sessionId: 'mock-session', cost: 0.2,
  usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 0 } };
const pin: OrchestratorEvent = { type: 'turn_receipt', leadModel: 'test-model', effort: 'high' };
const sendTurn = vi.fn<OrchestratorBackend['sendTurn']>();
const peekSession = vi.fn<OrchestratorBackend['peekSession']>();
let backend: OrchestratorBackend;
const reserve = vi.fn(async (intent: NativeModelStageIntent): Promise<NativeModelStageGrant | null> => grant(intent));
const verify = vi.fn(async (intent: NativeModelStageIntent): Promise<NativeModelStageConfinement | null> => confinement(intent));
const configured = (maxOutputBytes?: number) => createNativeModelStageAdapter({ admission: { reserve }, carrier: { verify }, maxOutputBytes });
function emit(events: OrchestratorEvent[]): void {
  sendTurn.mockImplementation(async (_repository, _prompt, onEvent) => { for (const event of events) onEvent(event); });
}

beforeEach(() => {
  registry.getOrchestratorBackend.mockReset(); sendTurn.mockReset(); peekSession.mockReset();
  peekSession.mockReturnValue(null);
  reserve.mockReset(); reserve.mockImplementation(async (intent) => grant(intent));
  verify.mockReset(); verify.mockImplementation(async (intent) => confinement(intent));
  backend = { id: 'codex', label: 'Mock only', boundedRefinement: { version: 1, singleAttempt: true, noAuxiliaryModelCalls: true },
    peekSession, ensureSession: vi.fn(), sendTurn };
  registry.getOrchestratorBackend.mockReturnValue(backend);
  emit([pin, { type: 'text', text: '{"harness":{"instructions":"Protocol refinement."}}' }, done]);
});
afterEach(() => vi.useRealTimers());

describe('native model-stage adapter, mocked registry protocol only', () => {
  it('does not interpret a manifest as approval or load a backend without trusted admission', async () => {
    const result = await createNativeModelStageAdapter().run(protocolState());
    expect(result).toMatchObject({ status: 'refused', reason: 'approval_required', attempt: null });
    expect(registry.getOrchestratorBackend).not.toHaveBeenCalled();
  });
  it('refuses execution even with all model-stage dependencies supplied', async () => {
    expect(await configured().run(protocolState('execute'))).toMatchObject({ reason: 'execute_requires_packet' });
    expect(registry.getOrchestratorBackend).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
  });
  it('does not relabel fixture experiments as native observations', async () => {
    expect(await configured().run(protocolState('propose_invariant', { provenance: 'fixture' }))).toMatchObject({ reason: 'fixture_forbidden' });
    expect(sendTurn).not.toHaveBeenCalled();
  });
  it('holds missing carrier isolation before registry load or reservation', async () => {
    expect(await createNativeModelStageAdapter({ admission: { reserve } }).run(protocolState()))
      .toMatchObject({ status: 'held', reason: 'carrier_confinement_required', attempt: null });
    expect(registry.getOrchestratorBackend).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
  });
  it.each(['missing', 'wrong_digest', 'no_isolation'] as const)('holds %s carrier evidence', async (variant) => {
    verify.mockImplementation(async (intent) => variant === 'missing' ? null : ({ ...confinement(intent),
      ...(variant === 'wrong_digest' ? { intentDigest: 'wrong' } : { hiddenEvaluationInaccessible: false }) } as NativeModelStageConfinement));
    expect(await configured().run(protocolState())).toMatchObject({ status: 'held', reason: 'carrier_confinement_required' });
    expect(reserve).not.toHaveBeenCalled(); expect(sendTurn).not.toHaveBeenCalled();
  });
  it('holds a backend without the source single-attempt contract', async () => {
    delete (backend as { boundedRefinement?: unknown }).boundedRefinement;
    expect(await configured().run(protocolState())).toMatchObject({ status: 'held', reason: 'backend_contract_unavailable' });
    expect(verify).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled(); expect(sendTurn).not.toHaveBeenCalled();
  });
  it('refuses unsupported runtimes and mutable/adaptive effort', async () => {
    expect(await configured().run(protocolState('propose_invariant', { runtime: 'collide' }))).toMatchObject({ reason: 'unsupported_runtime' });
    expect(await configured().run(protocolState('propose_invariant', { effort: 'adaptive' }))).toMatchObject({ reason: 'invalid_pins' });
    expect(sendTurn).not.toHaveBeenCalled();
  });
  it.each(['denied', 'wrong_digest', 'expired'] as const)('does not launch with %s approval', async (variant) => {
    reserve.mockImplementation(async (intent) => variant === 'denied' ? null : ({ ...grant(intent),
      ...(variant === 'wrong_digest' ? { intentDigest: 'wrong' } : { expiresAt: Date.now() - 1 }) }));
    const result = await configured().run(protocolState());
    expect(result.status).toBe('refused'); expect(sendTurn).not.toHaveBeenCalled();
  });
  it('passes exact bounded pins through the registry and ingests terminal structured output', async () => {
    const state = protocolState(); const result = await configured().run(state);
    expect(result).toMatchObject({ status: 'settled', reason: null });
    expect(registry.getOrchestratorBackend).toHaveBeenCalledWith('codex');
    const intent = reserve.mock.calls[0]![0];
    expect(intent).toMatchObject({ requestDigest: digest(state.pending), stateDigest: digest(state),
      permissionMode: 'plan', toolProfile: 'propose', attempts: 1, model: 'test-model', effort: 'high' });
    expect(intent.threadId).toMatch(/^thoughts-harness-/);
    expect(sendTurn.mock.calls[0]![3]).toMatchObject({ boundedRefinement: true, permissionMode: 'plan', toolProfile: 'propose',
      orchestrationMode: 'fleet', model: 'test-model', thinkingEffort: 'high', serviceTier: 'default',
      freshSession: true, threadId: intent.threadId });
    expect(result.state.records.at(-1)?.receipt).toMatchObject({ status: 'completed',
      harness: { instructions: 'Protocol refinement.' }, usage: { attempts: 1, inputTokens: 100, outputTokens: 20,
        actualUsd: null, estimatedUsd: 0.2, billing: 'unknown', humanMs: null } });
    expect(state.pending).not.toBeNull();
    expect(result.attempt?.confinementDigest).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each(['propose_invariant', 'propose_domain', 'compose', 'select', 'reflect'] as const)('ingests the %s schema', async (kind) => {
    const state = protocolState(kind);
    emit([pin, { type: 'text', text: JSON.stringify(payload(state.pending!)) }, done]);
    const result = await configured().run(state);
    expect(result.status).toBe('settled'); expect(result.state.records.at(-1)?.receipt.status).toBe('completed');
  });
  it('keeps selector identities and trajectories out of the model prompt', async () => {
    const state = protocolState('select'); emit([pin, { type: 'text', text: '{}' }, done]);
    await configured().run(state);
    const prompt = sendTurn.mock.calls[0]![1];
    expect(prompt).not.toContain('HARNESS_IDENTITY_DO_NOT_SHOW_SELECTOR');
    expect(prompt).not.toContain('TRAJECTORY_DO_NOT_SHOW_SELECTOR');
    const supplied = JSON.parse(prompt.slice(prompt.indexOf('{"input":'))) as { input: Record<string, unknown> };
    expect(Object.keys(supplied.input)).toEqual(['task', 'choices']);
  });
  it.each(['not JSON', '{"harness":{"instructions":"x"},"usage":{"actualUsd":0}}', '[]',
    '{"choice":"cross-stage"}', '{"provenance":"native"}'])('charges malformed terminal output once: %s', async (output) => {
    emit([pin, { type: 'text', text: output }, done]);
    const result = await configured().run(protocolState());
    expect(result.state.records.at(-1)?.receipt).toMatchObject({ status: 'failed', failureReason: 'invalid_stage_output',
      usage: { attempts: 1, inputTokens: 100, outputTokens: 20, estimatedUsd: 0.2, actualUsd: null } });
    expect(sendTurn).toHaveBeenCalledTimes(1);
  });
  it('does not invent zero usage or billed cost from a subscription backend', async () => {
    emit([pin, { type: 'text', text: '{"harness":{"instructions":"x"}}' }, { type: 'done', sessionId: null, cost: null }]);
    const result = await configured().run(protocolState());
    expect(result.attempt?.usage).toMatchObject({ inputTokens: null, outputTokens: null, actualUsd: null, estimatedUsd: null, billing: 'unknown' });
  });
  it('preserves observed mismatched pins and costs without forging a valid engine receipt', async () => {
    emit([{ type: 'turn_receipt', leadModel: 'other-model', effort: 'medium' }, done]);
    const state = protocolState(); const result = await configured().run(state);
    expect(result).toMatchObject({ status: 'uncertain', reason: 'pin_mismatch', state,
      attempt: { model: 'other-model', effort: 'medium', terminalObserved: true, usage: { estimatedUsd: 0.2 } } });
  });
  it('preserves unknown pins when the backend never supplied a receipt', async () => {
    emit([done]);
    expect(await configured().run(protocolState())).toMatchObject({ status: 'uncertain', reason: 'missing_turn_receipt',
      attempt: { model: null, effort: null, usage: { inputTokens: 100 } } });
  });
  it('preserves a failed terminal attempt rather than repairing it with another call', async () => {
    emit([pin, { type: 'error', error: 'Do not persist this provider detail' }, done]);
    const result = await configured().run(protocolState());
    expect(result).toMatchObject({ status: 'settled', reason: 'backend_error' });
    expect(result.state.records.at(-1)?.receipt).toMatchObject({ status: 'failed', usage: { estimatedUsd: 0.2 } });
    expect(JSON.stringify(result)).not.toContain('provider detail'); expect(sendTurn).toHaveBeenCalledTimes(1);
  });
  it('never relaunches an uncertain or concurrently reserved request', async () => {
    emit([pin]); const state = protocolState(); const adapter = configured();
    const [first, second] = await Promise.all([adapter.run(state), adapter.run(state)]);
    expect([first.reason, second.reason]).toContain('already_reserved');
    expect([first.reason, second.reason]).toContain('missing_terminal_event');
    expect(sendTurn).toHaveBeenCalledTimes(1);
    expect(await adapter.run(state)).toMatchObject({ reason: 'already_reserved' });
    const uncertain = first.status === 'uncertain' ? first : second;
    expect(uncertain.state).toMatchObject({ status: 'blocked', blockedReason: 'execution_outcome_unknown' });
    expect(await configured().run(uncertain.state)).toMatchObject({ reason: 'not_pending' });
  });
  it('bounds a hanging turn and ignores late stream data without claiming it stopped remotely', async () => {
    vi.useFakeTimers();
    let late!: (event: OrchestratorEvent) => void; let options!: OrchestratorTurnOptions;
    sendTurn.mockImplementation((_repo, _prompt, onEvent, opts) => {
      late = onEvent; options = opts!; onEvent(pin); return new Promise(() => {});
    });
    const running = configured().run(protocolState());
    await vi.waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1000); const result = await running;
    expect(result).toMatchObject({ status: 'uncertain', reason: 'wall_budget_exceeded' });
    expect(options.signal?.aborted).toBe(true);
    late(done); expect(result.attempt?.terminalObserved).toBe(false);
    expect(result.attempt?.usage.estimatedUsd).toBeNull();
  });
  it.each([
    [{ type: 'turn_retry', attempt: 2, reason: 'fallback', notice: 'retry' }, 'backend_retry_forbidden'],
    [{ type: 'tool_use', name: 'Read', input: {} }, 'tool_use_forbidden'],
    [{ type: 'handoff', from: null, to: { backend: 'claude', model: null }, lossless: false }, 'handoff_forbidden'],
  ] as const)('aborts an unexpected transport boundary (%s)', async (event, reason) => {
    emit([pin, event, done]); const result = await configured().run(protocolState());
    expect(result).toMatchObject({ status: 'uncertain', reason });
    expect(sendTurn.mock.calls[0]![3]!.signal?.aborted).toBe(true); expect(sendTurn).toHaveBeenCalledTimes(1);
  });
  it('bounds streamed output before accumulating an oversized payload', async () => {
    emit([pin, { type: 'text', text: 'x'.repeat(1025) }, done]);
    expect(await configured(1024).run(protocolState())).toMatchObject({ status: 'uncertain', reason: 'output_budget_exceeded' });
  });
  it('refuses a pre-existing native session even when idle', async () => {
    peekSession.mockReturnValue({ sessionName: 'existing', status: 'ready' });
    expect(await configured().run(protocolState())).toMatchObject({ status: 'uncertain', reason: 'session_not_fresh' });
    expect(sendTurn).not.toHaveBeenCalled();
  });
});
