import { createHash } from 'node:crypto';
import type { ImprovementHarness, ImprovementManifest, ImprovementReceipt } from './types';

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error('Non-JSON experiment value.');
  return result;
}
export const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
export function object(value: unknown, keys: string[], required = keys): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object.');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !keys.includes(key)) || required.some((key) => !Object.hasOwn(row, key))) {
    throw new Error('Unexpected or missing experiment field.');
  }
  return row;
}
export function text(value: unknown, max = 65536): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max) throw new Error('Invalid bounded text.');
}
export function integer(value: unknown, min: number, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error('Invalid bounded integer.');
}
export function harness(value: unknown): asserts value is ImprovementHarness {
  const row = object(value, ['instructions', 'memory', 'skills', 'toolGuidance'], ['instructions']);
  for (const entry of Object.values(row)) text(entry, 16384);
}
/** Deliberately narrow advisory scope. Denylists do not attest secret/evaluator isolation. */
export function artifactInventory(value: unknown): asserts value is NonNullable<ImprovementManifest['artifactInventory']> {
  const row = object(value, ['files', 'maxFileBytes', 'maxTotalBytes']);
  integer(row.maxFileBytes, 1, 32768); integer(row.maxTotalBytes, 1, 32768);
  if (Number(row.maxFileBytes) > Number(row.maxTotalBytes) || !Array.isArray(row.files)
    || row.files.length < 1 || row.files.length > 16) throw new Error('Invalid artifact inventory bounds.');
  const files = row.files as unknown[];
  for (const path of files) {
    text(path, 256);
    if (!/^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/.test(path)
      || path.split('/').some(part => !part || part === '.' || part === '..'
        || /^(?:\.|node_modules$|harness-refinement|runs$|logs?$|credentials?$|secrets?$|private$|evaluators?$|oracle$|scorers?$|benchmarks?$)/i.test(part))
      || /(?:^|[./_-])(?:secret|credential|token|password|private|oracle|evaluator|scorer|session|config|env)(?:[./_-]|$)/i.test(path)
      || /\.(?:pem|key|p12|pfx|sqlite|db|log|jsonl)$/i.test(path)) throw new Error('Unsafe artifact inventory path.');
  }
  if (new Set(files).size !== files.length || canonical(files) !== canonical([...files].sort())) {
    throw new Error('Artifact inventory must be unique and sorted.');
  }
}

export function manifest(value: unknown): asserts value is ImprovementManifest {
  const row = object(value, ['id', 'repository', 'baselineRevision', 'contractDigest', 'verifierDigest', 'permissionsDigest',
    'runtime', 'model', 'effort', 'provenance', 'mode', 'k', 'maxStages', 'maxStageWallMs', 'maxInputBytes', 'baseline', 'tasks', 'artifactInventory'],
  ['id', 'repository', 'baselineRevision', 'contractDigest', 'verifierDigest', 'permissionsDigest',
    'runtime', 'model', 'effort', 'provenance', 'mode', 'k', 'maxStages', 'maxStageWallMs', 'maxInputBytes', 'baseline', 'tasks']);
  if (row.artifactInventory !== undefined) artifactInventory(row.artifactInventory);
  text(row.id, 128);
  for (const key of ['repository', 'runtime', 'model', 'effort']) text(row[key], 1024);
  for (const key of ['contractDigest', 'verifierDigest', 'permissionsDigest']) {
    if (typeof row[key] !== 'string' || !/^[a-f0-9]{64}$/.test(row[key])) throw new Error('Invalid digest pin.');
  }
  if (typeof row.baselineRevision !== 'string' || !/^[a-f0-9]{40}$/.test(row.baselineRevision)) throw new Error('Invalid base pin.');
  if (!['fixture', 'native'].includes(String(row.provenance))) throw new Error('Invalid experiment provenance.');
  if (!['parallel', 'sequential'].includes(String(row.mode))) throw new Error('Invalid recursion mode.');
  integer(row.k, 1, 8); integer(row.maxStages, 1, 1000); integer(row.maxStageWallMs, 1, 3600000);
  integer(row.maxInputBytes, 1024, 2 * 1024 * 1024); harness(row.baseline);
  if (!Array.isArray(row.tasks) || !row.tasks.length || row.tasks.length > 32) throw new Error('Invalid task sequence.');
  const ids = new Set<string>();
  for (const item of row.tasks) {
    const task = object(item, ['id', 'domain', 'prompt']);
    text(task.id, 128); text(task.domain, 128); text(task.prompt);
    if (ids.has(task.id)) throw new Error('Duplicate task.');
    ids.add(task.id);
  }
}
export function receipt(value: unknown): asserts value is ImprovementReceipt {
  const row = object(value, ['requestId', 'requestDigest', 'status', 'provenance', 'runtime', 'model', 'effort',
    'harness', 'artifact', 'trajectory', 'choice', 'lesson', 'decisions', 'failureReason', 'usage'],
  ['requestId', 'requestDigest', 'status', 'provenance', 'runtime', 'model', 'effort', 'usage']);
  for (const key of ['requestId', 'requestDigest', 'runtime', 'model', 'effort']) text(row[key], 1024);
  if (!['completed', 'failed', 'uncertain'].includes(String(row.status)) || !['fixture', 'native'].includes(String(row.provenance))) {
    throw new Error('Invalid receipt state.');
  }
  if (row.failureReason !== undefined && (row.failureReason !== 'invalid_stage_output' || row.status !== 'failed')) throw new Error('Invalid failure reason.');
  if (row.status !== 'completed' && ['harness', 'artifact', 'trajectory', 'choice', 'lesson', 'decisions'].some((key) => row[key] !== undefined)) throw new Error('Noncompleted receipt cannot carry model output.');
  if (row.harness !== undefined) harness(row.harness);
  for (const key of ['artifact', 'trajectory', 'choice']) if (row[key] !== undefined) text(row[key]);
  if (row.decisions !== undefined) {
    if (!Array.isArray(row.decisions) || !row.decisions.length || row.decisions.length > 16) throw new Error('Invalid composition decisions.');
    for (const entry of row.decisions) {
      const decision = object(entry, ['action', 'rationale', 'sourceRequestIds']);
      if (!['preserve', 'adopt', 'revise'].includes(String(decision.action))) throw new Error('Invalid composition action.');
      text(decision.rationale, 4096);
      if (!Array.isArray(decision.sourceRequestIds) || !decision.sourceRequestIds.length || decision.sourceRequestIds.length > 128) throw new Error('Missing composition evidence.');
      for (const id of decision.sourceRequestIds) text(id, 128);
      if (new Set(decision.sourceRequestIds).size !== decision.sourceRequestIds.length) throw new Error('Duplicate composition evidence.');
    }
  }
  if (row.lesson !== undefined) {
    const lesson = object(row.lesson, ['text', 'sourceRequestIds', 'expiresAfterTask']);
    text(lesson.text, 8192); integer(lesson.expiresAfterTask, 0, 31);
    if (!Array.isArray(lesson.sourceRequestIds) || !lesson.sourceRequestIds.length || lesson.sourceRequestIds.length > 128) throw new Error('Missing lesson evidence.');
    for (const id of lesson.sourceRequestIds) text(id, 128);
    if (new Set(lesson.sourceRequestIds).size !== lesson.sourceRequestIds.length) throw new Error('Duplicate lesson evidence.');
  }
  const usage = object(row.usage, ['attempts', 'inputTokens', 'outputTokens', 'actualUsd', 'estimatedUsd', 'wallMs', 'humanMs', 'billing']);
  integer(usage.attempts, 1, 1); integer(usage.wallMs, 0, 86400000);
  for (const key of ['inputTokens', 'outputTokens', 'humanMs']) if (usage[key] !== null) integer(usage[key], 0, Number.MAX_SAFE_INTEGER);
  for (const key of ['actualUsd', 'estimatedUsd']) if (usage[key] !== null &&
    (typeof usage[key] !== 'number' || !Number.isFinite(usage[key]) || usage[key] < 0)) throw new Error('Invalid cost.');
  if (!['subscription', 'api', 'unknown'].includes(String(usage.billing))) throw new Error('Invalid billing provenance.');
}
