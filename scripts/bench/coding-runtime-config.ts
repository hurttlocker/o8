import fs from 'node:fs';
import path from 'node:path';

import { isManualThinkingEffort, type ManualThinkingEffort } from '../../src/lib/orchestrator/thinking-effort';
import { CODING_JUDGES, CODING_RUNTIMES, type CodingJudge, type CodingRuntime } from './coding';

export const CODING_RUNTIME_CONFIG_ENV = 'O8_BENCH_RUNTIME_CONFIG';

export interface CodingRequestedSettings {
  model: string;
  effort: ManualThinkingEffort;
}

export interface CodingRuntimeConfig {
  schema: 'o8/coding-runtime-config/v1';
  arms: Record<CodingRuntime, CodingRequestedSettings>;
  judges: Record<CodingJudge, CodingRequestedSettings>;
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(record: Record<string, unknown>, keys: string[], label: string): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} must contain exactly: ${expected.join(', ')}`);
  }
}

function requestedSettings(value: unknown, label: string): CodingRequestedSettings {
  const record = objectRecord(value, label);
  assertExactKeys(record, ['model', 'effort'], label);
  const model = typeof record.model === 'string' ? record.model.trim() : '';
  if (!/^[a-z0-9][a-z0-9._:/@+-]{0,127}$/i.test(model)) {
    throw new Error(`${label}.model must be a non-empty launcher model id`);
  }
  if (!isManualThinkingEffort(record.effort)) {
    throw new Error(`${label}.effort must be one of low, medium, high, max, xhigh, or ultra`);
  }
  return { model, effort: record.effort };
}

function settingsMap<T extends CodingRuntime | CodingJudge>(
  value: unknown,
  keys: T[],
  label: string,
): Record<T, CodingRequestedSettings> {
  const record = objectRecord(value, label);
  assertExactKeys(record, keys, label);
  return Object.fromEntries(keys.map((key) => [
    key,
    requestedSettings(record[key], `${label}.${key}`),
  ])) as Record<T, CodingRequestedSettings>;
}

export function parseCodingRuntimeConfig(value: unknown): CodingRuntimeConfig {
  const record = objectRecord(value, 'coding runtime config');
  assertExactKeys(record, ['schema', 'arms', 'judges'], 'coding runtime config');
  if (record.schema !== 'o8/coding-runtime-config/v1') {
    throw new Error('coding runtime config schema must be o8/coding-runtime-config/v1');
  }
  return {
    schema: record.schema,
    arms: settingsMap(record.arms, CODING_RUNTIMES, 'coding runtime config.arms'),
    judges: settingsMap(record.judges, CODING_JUDGES, 'coding runtime config.judges'),
  };
}

export function readCodingRuntimeConfig(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): CodingRuntimeConfig {
  const configuredPath = env[CODING_RUNTIME_CONFIG_ENV]?.trim();
  if (!configuredPath) {
    throw new Error(`${CODING_RUNTIME_CONFIG_ENV} must point to a coding runtime JSON config`);
  }
  const configPath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(repoRoot, configuredPath);
  let raw: string;
  try {
    if (!fs.statSync(configPath).isFile()) throw new Error('not a regular file');
    raw = fs.readFileSync(configPath, 'utf8');
  } catch {
    throw new Error(`${CODING_RUNTIME_CONFIG_ENV} could not read the configured JSON file`);
  }
  if (Buffer.byteLength(raw, 'utf8') > 64 * 1024) {
    throw new Error('coding runtime config exceeds 64 KiB');
  }
  try {
    return parseCodingRuntimeConfig(JSON.parse(raw));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid coding runtime config: ${detail}`);
  }
}

export function assertMatchingCodingRuntimeConfig(
  recorded: unknown,
  requested: CodingRuntimeConfig,
): void {
  if (recorded === undefined) {
    throw new Error('collection receipt predates requested runtime settings and cannot start new judging workers');
  }
  const parsed = parseCodingRuntimeConfig(recorded);
  if (JSON.stringify(parsed) !== JSON.stringify(requested)) {
    throw new Error('coding runtime config does not match the immutable collection receipt');
  }
}
