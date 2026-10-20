import { createHash } from 'node:crypto';
import { digest, integer, object, text } from './validation';

/** Independent evaluator artifacts. Never pass these to proposer/composer/lesson inputs. */
export interface SealedEvaluationRequest {
  schemaVersion: 1;
  taskId: string;
  fixtureManifestHash: string;
  artifactSnapshot: { files: Array<{ path: string; sha256: string }>; snapshotHash: string };
  completionClaim: { text: string; sha256: string };
}
export interface SealedEvaluationReceipt {
  schemaVersion: 1;
  taskId: string;
  fixtureManifestHash: string;
  snapshotHash: string;
  claimHash: string;
  evaluatorVersion: string;
  passed: boolean;
  behaviorPassed: boolean;
  preservationPassed: boolean;
  checks: Array<{ id: string; passed: boolean }>;
  receiptHash: string;
}
export interface SealedEvaluationPins {
  taskId: string;
  fixtureManifestHash: string;
  evaluatorVersion: string;
}
function sha(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid evaluation digest.');
}
export function validateSealedEvaluationRequest(value: unknown): asserts value is SealedEvaluationRequest {
  const request = object(value, ['schemaVersion', 'taskId', 'fixtureManifestHash', 'artifactSnapshot', 'completionClaim']);
  if (request.schemaVersion !== 1) throw new Error('Unsupported evaluation schema.');
  text(request.taskId, 128); sha(request.fixtureManifestHash);
  const snapshot = object(request.artifactSnapshot, ['files', 'snapshotHash']); sha(snapshot.snapshotHash);
  if (!Array.isArray(snapshot.files)) throw new Error('Invalid snapshot files.');
  integer(snapshot.files.length, 1, 1000);
  const paths = new Set<string>();
  for (const file of snapshot.files) {
    const entry = object(file, ['path', 'sha256']); text(entry.path, 512); sha(entry.sha256);
    if (!/^[A-Za-z0-9._/-]+$/.test(entry.path) || entry.path.startsWith('/') || entry.path.includes('\\') || entry.path.split('/').some((part) => !part || part === '.' || part === '..')
      || paths.has(entry.path)) throw new Error('Invalid or duplicate snapshot path.');
    paths.add(entry.path);
  }
  const orderedPaths = [...paths];
  if (!paths.has('fixture-manifest.json') || orderedPaths.some((path, index) => index > 0 && orderedPaths[index - 1] >= path)) {
    throw new Error('Snapshot must include fixture manifest and be lexically path-sorted.');
  }
  if (snapshot.snapshotHash !== digest(snapshot.files)) throw new Error('Snapshot digest differs.');
  const claim = object(request.completionClaim, ['text', 'sha256']); sha(claim.sha256);
  if (typeof claim.text !== 'string' || Buffer.byteLength(claim.text) > 65536) throw new Error('Invalid completion claim.');
  // Preserve exact raw text, including whitespace and an honestly absent claim.
  if (claim.sha256 !== createHash('sha256').update(claim.text).digest('hex')) throw new Error('Claim digest differs.');
}

/** Hash/binding verification is necessary, not proof of an independent trusted evaluator. */
export function verifySealedEvaluationReceipt(request: SealedEvaluationRequest, value: unknown,
  pins: SealedEvaluationPins): SealedEvaluationReceipt {
  validateSealedEvaluationRequest(request);
  object(pins, ['taskId', 'fixtureManifestHash', 'evaluatorVersion']);
  text(pins.taskId, 128); sha(pins.fixtureManifestHash); text(pins.evaluatorVersion, 128);
  const row = object(value, ['schemaVersion', 'taskId', 'fixtureManifestHash', 'snapshotHash', 'claimHash',
    'evaluatorVersion', 'passed', 'behaviorPassed', 'preservationPassed', 'checks', 'receiptHash']);
  if (row.schemaVersion !== 1 || request.taskId !== pins.taskId || request.fixtureManifestHash !== pins.fixtureManifestHash
    || row.taskId !== request.taskId || row.fixtureManifestHash !== request.fixtureManifestHash
    || row.snapshotHash !== request.artifactSnapshot.snapshotHash || row.claimHash !== request.completionClaim.sha256
    || row.evaluatorVersion !== pins.evaluatorVersion) throw new Error('Evaluation binding differs from the frozen task/artifact.');
  for (const key of ['passed', 'behaviorPassed', 'preservationPassed']) if (typeof row[key] !== 'boolean') throw new Error('Invalid evaluation result.');
  sha(row.receiptHash);
  if (!Array.isArray(row.checks)) throw new Error('Invalid evaluation checks.');
  integer(row.checks.length, 1, 1000);
  const ids = new Set<string>();
  for (const check of row.checks) {
    const entry = object(check, ['id', 'passed']); text(entry.id, 128);
    if (typeof entry.passed !== 'boolean' || ids.has(entry.id)) throw new Error('Invalid duplicate evaluation check.');
    ids.add(entry.id);
  }
  if (row.passed !== (row.behaviorPassed && row.preservationPassed)
    || (row.passed && row.checks.some((check) => !check.passed))) throw new Error('Inconsistent evaluation verdict.');
  const { receiptHash, ...payload } = row;
  if (receiptHash !== digest(payload)) throw new Error('Evaluation receipt digest differs.');
  return structuredClone(row) as unknown as SealedEvaluationReceipt;
}
