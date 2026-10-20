import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateSealedEvaluationRequest, verifySealedEvaluationReceipt, type SealedEvaluationRequest } from './evaluation';
import { digest } from './validation';

function fixture() {
  const files = [{ path: 'fixture-manifest.json', sha256: 'c'.repeat(64) }, { path: 'src/example.ts', sha256: 'a'.repeat(64) }];
  const claim = '  Fixture claim, not model output.\n';
  const request: SealedEvaluationRequest = { schemaVersion: 1, taskId: 'synthetic-A', fixtureManifestHash: 'b'.repeat(64),
    artifactSnapshot: { files, snapshotHash: digest(files) },
    completionClaim: { text: claim, sha256: createHash('sha256').update(claim).digest('hex') } };
  const payload = { schemaVersion: 1 as const, taskId: request.taskId, fixtureManifestHash: request.fixtureManifestHash,
    snapshotHash: request.artifactSnapshot.snapshotHash, claimHash: request.completionClaim.sha256,
    evaluatorVersion: 'fixture-only-v1', passed: true, behaviorPassed: true, preservationPassed: true,
    checks: [{ id: 'fixture-check', passed: true }] };
  return { request, receipt: { ...payload, receiptHash: digest(payload) },
    pins: { taskId: request.taskId, fixtureManifestHash: request.fixtureManifestHash, evaluatorVersion: payload.evaluatorVersion } };
}

describe('external evaluator schema fixtures, no hidden oracle or live efficacy', () => {
  it('verifies exact task/artifact/claim/version binding without changing claim text', () => {
    const { request, receipt, pins } = fixture();
    expect(verifySealedEvaluationReceipt(request, receipt, pins)).toEqual(receipt);
    expect(request.completionClaim.text).toBe('  Fixture claim, not model output.\n');
  });
  it('rejects forged hash, wrong source, extra policy fields and inconsistent verdicts', () => {
    const { request, receipt, pins } = fixture();
    for (const altered of [{ ...receipt, receiptHash: 'c'.repeat(64) }, { ...receipt, snapshotHash: 'c'.repeat(64) },
      { ...receipt, approved: true }, { ...receipt, behaviorPassed: false }]) {
      expect(() => verifySealedEvaluationReceipt(request, altered, pins)).toThrow();
    }
    expect(() => verifySealedEvaluationReceipt(request, receipt, { ...pins, evaluatorVersion: 'other' })).toThrow();
  });
  it('rejects snapshot path escape, duplicate entries and claim normalization', () => {
    const { request } = fixture();
    for (const path of ['../answer', '/answer', 'src/../answer', 'a\\b', './a']) {
      const files = [{ path, sha256: 'a'.repeat(64) }];
      expect(() => validateSealedEvaluationRequest({ ...request, artifactSnapshot: { files, snapshotHash: digest(files) } })).toThrow();
    }
    expect(() => validateSealedEvaluationRequest({ ...request,
      completionClaim: { ...request.completionClaim, text: request.completionClaim.text.trim() } })).toThrow();
  });
  it('allows an honestly empty completion claim instead of fabricating one', () => {
    const { request } = fixture();
    request.completionClaim = { text: '', sha256: createHash('sha256').update('').digest('hex') };
    expect(() => validateSealedEvaluationRequest(request)).not.toThrow();
  });
});
