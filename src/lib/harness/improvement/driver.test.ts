import { describe, expect, it, vi } from 'vitest';
import { createExperiment, advanceExperiment, settleExperiment } from './engine';
import { driveImprovementStage, type ImprovementDriverHost } from './driver';
import type { ImprovementExperiment, ImprovementManifest } from './types';
import { digest } from './validation';

const manifest: ImprovementManifest = {
  id: 'driver', repository: '/test/repo', baselineRevision: 'a'.repeat(40), contractDigest: 'b'.repeat(64),
  verifierDigest: 'c'.repeat(64), permissionsDigest: 'd'.repeat(64), runtime: 'codex', model: 'fixture-model',
  effort: 'high', provenance: 'fixture', mode: 'parallel', k: 1, maxStages: 20,
  maxStageWallMs: 1000, maxInputBytes: 100000, baseline: { instructions: 'Test only' },
  tasks: [{ id: 'A', domain: 'code', prompt: 'Fixture' }],
};
function fixture() {
  let stored = createExperiment(manifest);
  const host: ImprovementDriverHost = {
    journal: { read: () => structuredClone(stored), append: (next, revision) => {
      if (revision !== stored.revision) throw new Error('CAS');
      stored = structuredClone(next); return stored;
    } },
    model: {}, persistAttempt: vi.fn(async () => {}),
  };
  return { host, read: () => stored };
}

describe('durable stage driver protocol, no live adapters', () => {
  it('holds without creating a reservation when writable adapter is unavailable', async () => {
    const { host, read } = fixture();
    const result = await driveImprovementStage(host, 'driver', 0);
    expect(result.reason).toBe('governed_writable_packet_adapter_required');
    expect(read().revision).toBe(0);
  });
  it('persists before adapter call and never automatically redrives a crashed reservation', async () => {
    const { host, read } = fixture();
    host.execute = vi.fn(async (state) => {
      expect(read().pending?.id).toBe(state.pending?.id);
      throw new Error('unknown outcome');
    });
    expect((await driveImprovementStage(host, 'driver', 0)).status).toBe('uncertain');
    expect((await driveImprovementStage(host, 'driver', read().revision)).reason).toBe('reconcile_existing_reservation');
    expect(host.execute).toHaveBeenCalledTimes(1);
  });
  it('does not execute after a lost CAS', async () => {
    const { host } = fixture(); host.journal.append = () => { throw new Error('CAS'); };
    host.execute = vi.fn();
    await expect(driveImprovementStage(host, 'driver', 0)).rejects.toThrow('CAS');
    expect(host.execute).not.toHaveBeenCalled();
  });
  it('persists a completed stage without claiming experiment success', async () => {
    const { host, read } = fixture();
    host.execute = async (state: ImprovementExperiment) => ({ status: 'settled', reason: null, attempt: null,
      state: settleExperiment(state, { requestId: state.pending!.id, requestDigest: digest(state.pending),
        status: 'completed', provenance: 'fixture', runtime: 'codex', model: 'fixture-model', effort: 'high', artifact: 'fixture artifact',
        usage: { attempts: 1, inputTokens: null, outputTokens: null, actualUsd: null, estimatedUsd: null,
          wallMs: 1, humanMs: null, billing: 'unknown' } }) });
    const result = await driveImprovementStage(host, 'driver', 0);
    expect(result.status).toBe('advanced'); expect(read().records).toHaveLength(1);
    expect(read().acceptance.liveBenefitProven).toBe(false);
  });
  it('refuses pre-existing reservations even before any receipt', async () => {
    const { host } = fixture(); host.journal.read = () => advanceExperiment(createExperiment(manifest));
    host.execute = vi.fn();
    expect((await driveImprovementStage(host, 'driver', 1)).status).toBe('held');
    expect(host.execute).not.toHaveBeenCalled();
  });
});
