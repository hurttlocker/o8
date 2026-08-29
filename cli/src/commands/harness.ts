import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { apiFetch, CliError, EXIT, SLOW_MUTATION_TIMEOUT_MS } from '../api.js';
import { resolveConfig } from '../config.js';
import { printHumanHeading, printJson, type OutputMode } from '../output.js';
import { resolveLaneFromCwd } from './packet/worktree-resolve.js';

interface ParsedFlags {
  positionals: string[];
  flags: Set<string>;
  values: Map<string, string[]>;
}

interface HarnessResponse<T = unknown> {
  ok?: boolean;
  result?: T;
  error?: { code?: string; message?: string } | string;
}

const BOOLEAN_FLAGS = new Set([
  'failing', 'passing', 'blocked', 'passed', 'failed', 'skipped',
]);

function parseFlags(rest: string[]): ParsedFlags {
  const positionals: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string[]>();
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    const key = token.slice(2, equals >= 0 ? equals : undefined);
    if (!key) throw new CliError('invalid_args', 'empty flag name', EXIT.INVALID_ARGS);
    if (equals >= 0) {
      const value = token.slice(equals + 1);
      values.set(key, [...(values.get(key) ?? []), value]);
      continue;
    }
    if (BOOLEAN_FLAGS.has(key)) {
      flags.add(key);
      continue;
    }
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new CliError('invalid_args', `--${key} requires a value`, EXIT.INVALID_ARGS);
    }
    values.set(key, [...(values.get(key) ?? []), next]);
    i += 1;
  }
  return { positionals, flags, values };
}

function value(parsed: ParsedFlags, key: string): string | null {
  const entries = parsed.values.get(key);
  return entries?.[entries.length - 1]?.trim() || null;
}

function values(parsed: ParsedFlags, key: string): string[] {
  return (parsed.values.get(key) ?? []).map((entry) => entry.trim()).filter(Boolean);
}

function requiredValue(parsed: ParsedFlags, key: string): string {
  const result = value(parsed, key);
  if (!result) throw new CliError('invalid_args', `--${key} is required`, EXIT.INVALID_ARGS);
  return result;
}

function numericValue(parsed: ParsedFlags, key: string): number | undefined {
  const raw = value(parsed, key);
  if (!raw) return undefined;
  const result = Number(raw);
  if (!Number.isFinite(result)) throw new CliError('invalid_args', `--${key} must be a number`, EXIT.INVALID_ARGS);
  return result;
}

function jsonObject(parsed: ParsedFlags, key: string): Record<string, unknown> | undefined {
  const raw = value(parsed, key);
  if (!raw) return undefined;
  try {
    const parsedValue = JSON.parse(raw) as unknown;
    if (!parsedValue || typeof parsedValue !== 'object' || Array.isArray(parsedValue)) throw new Error('not an object');
    return parsedValue as Record<string, unknown>;
  } catch {
    throw new CliError('invalid_args', `--${key} must be a JSON object`, EXIT.INVALID_ARGS);
  }
}

function jsonCommand(parsed: ParsedFlags, key: string): string[] | undefined {
  const raw = value(parsed, key);
  if (!raw) return undefined;
  try {
    const parsedValue = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsedValue) || parsedValue.some((entry) => typeof entry !== 'string')) throw new Error('not a string array');
    return parsedValue;
  } catch {
    throw new CliError('invalid_args', `--${key} must be a JSON array of command arguments`, EXIT.INVALID_ARGS);
  }
}

async function packetIdFromCwd(): Promise<string | null> {
  try {
    const lane = await resolveLaneFromCwd();
    return lane?.packetId ?? lane?.match.packetSlug ?? null;
  } catch {
    return null;
  }
}

async function harnessCall<T>(
  action: string,
  body: Record<string, unknown>,
  timeoutMs = SLOW_MUTATION_TIMEOUT_MS,
): Promise<T> {
  const cfg = resolveConfig();
  const packetId = await packetIdFromCwd();
  const response = await apiFetch<HarnessResponse<T>>(cfg, '/api/harness', {
    method: 'POST',
    timeoutMs,
    body: {
      action,
      ...body,
      ...(packetId ? { packetId } : {}),
    },
  });
  const data = response.data;
  if (!data?.ok) {
    const message = typeof data?.error === 'string' ? data.error : data?.error?.message ?? 'Harness action failed.';
    throw new CliError('harness_action_failed', message, EXIT.CONFLICT);
  }
  return data.result as T;
}

function output(mode: OutputMode, heading: string, result: unknown): number {
  if (mode.human) {
    printHumanHeading(heading);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printJson(result);
  }
  return 0;
}

function selectedStatus(parsed: ParsedFlags): string | null {
  for (const status of ['failing', 'passing', 'blocked']) {
    if (parsed.flags.has(status)) return status;
  }
  return value(parsed, 'status');
}

function selectedCheckStatus(parsed: ParsedFlags): string {
  for (const status of ['passed', 'failed', 'skipped']) {
    if (parsed.flags.has(status)) return status;
  }
  return requiredValue(parsed, 'status');
}

export async function runFeature(mode: OutputMode, subcommand: string | undefined, rest: string[]): Promise<number> {
  const parsed = parseFlags(rest);
  const repoPath = value(parsed, 'repo') ?? process.cwd();
  if (subcommand === 'list') {
    return output(mode, 'feature ledger', await harnessCall('feature_list', {
      repoPath,
      ...(selectedStatus(parsed) ? { status: selectedStatus(parsed) } : {}),
      ...(numericValue(parsed, 'limit') ? { limit: numericValue(parsed, 'limit') } : {}),
    }));
  }
  if (subcommand === 'next') {
    return output(mode, 'next feature', await harnessCall('feature_next', { repoPath }));
  }
  if (subcommand === 'add') {
    return output(mode, 'feature added', await harnessCall('feature_add', {
      repoPath,
      title: requiredValue(parsed, 'title'),
      description: value(parsed, 'description') ?? '',
      ...(numericValue(parsed, 'priority') !== undefined ? { priority: numericValue(parsed, 'priority') } : {}),
      ...(jsonCommand(parsed, 'command-json') ? { verificationCommand: jsonCommand(parsed, 'command-json') } : {}),
      ...(jsonObject(parsed, 'metadata-json') ? { metadata: jsonObject(parsed, 'metadata-json') } : {}),
    }));
  }
  if (subcommand === 'verify') {
    const featureId = parsed.positionals[0];
    if (!featureId) throw new CliError('invalid_args', 'o8 feature verify requires a feature id', EXIT.INVALID_ARGS);
    return output(mode, 'feature verification', await harnessCall('feature_verify', {
      repoPath,
      featureId,
      status: selectedCheckStatus(parsed),
      evidence: value(parsed, 'evidence') ?? '',
      ...(jsonCommand(parsed, 'command-json') ? { command: jsonCommand(parsed, 'command-json') } : {}),
      ...(numericValue(parsed, 'exit-code') !== undefined ? { exitCode: numericValue(parsed, 'exit-code') } : {}),
      ...(value(parsed, 'model') ? { modelId: value(parsed, 'model') } : {}),
    }));
  }
  if (subcommand === 'status') {
    const featureId = parsed.positionals[0];
    if (!featureId) throw new CliError('invalid_args', 'o8 feature status requires a feature id', EXIT.INVALID_ARGS);
    return output(mode, 'feature status', await harnessCall('feature_status', {
      repoPath,
      featureId,
      status: requiredValue(parsed, 'status'),
    }));
  }
  throw new CliError('invalid_args', 'usage: o8 feature list|next|add|verify|status', EXIT.INVALID_ARGS);
}

export async function runGround(mode: OutputMode, rest: string[]): Promise<number> {
  const parsed = parseFlags(rest);
  const task = value(parsed, 'task') ?? parsed.positionals.join(' ').trim();
  if (!task) throw new CliError('invalid_args', 'o8 ground requires a task', EXIT.INVALID_ARGS);
  return output(mode, 'grounded impact map', await harnessCall('ground', {
    repoPath: value(parsed, 'repo') ?? process.cwd(),
    task,
    ...(value(parsed, 'feature') ? { featureId: value(parsed, 'feature') } : {}),
    acceptanceCriteria: values(parsed, 'accept'),
  }));
}

export async function runBoot(mode: OutputMode, rest: string[]): Promise<number> {
  const parsed = parseFlags(rest);
  const task = value(parsed, 'task') ?? parsed.positionals.join(' ').trim();
  return output(mode, 'session boot', await harnessCall('boot', {
    repoPath: value(parsed, 'repo') ?? process.cwd(),
    ...(task ? { task } : {}),
    ...(value(parsed, 'feature') ? { featureId: value(parsed, 'feature') } : {}),
    ...(value(parsed, 'model') ? { modelId: value(parsed, 'model') } : {}),
    acceptanceCriteria: values(parsed, 'accept'),
  }));
}

export async function runContract(mode: OutputMode, subcommand: string | undefined, rest: string[]): Promise<number> {
  const parsed = parseFlags(rest);
  const repoPath = value(parsed, 'repo') ?? process.cwd();
  if (subcommand === 'list') {
    return output(mode, 'contracts', await harnessCall('contract_list', { repoPath }));
  }
  if (subcommand === 'propose') {
    return output(mode, 'contract proposed', await harnessCall('contract_propose', {
      repoPath,
      ...(value(parsed, 'feature') ? { featureId: value(parsed, 'feature') } : {}),
      ...(value(parsed, 'grounding') ? { groundingId: value(parsed, 'grounding') } : {}),
      generatorTerms: requiredValue(parsed, 'generator'),
      evaluatorTerms: requiredValue(parsed, 'evaluator'),
      acceptanceCriteria: values(parsed, 'accept'),
    }));
  }
  const transitions: Record<string, string> = {
    accept: 'accepted',
    verify: 'verified',
    fail: 'failed',
    supersede: 'superseded',
  };
  if (subcommand && transitions[subcommand]) {
    const contractId = parsed.positionals[0];
    if (!contractId) throw new CliError('invalid_args', `o8 contract ${subcommand} requires a contract id`, EXIT.INVALID_ARGS);
    return output(mode, 'contract updated', await harnessCall('contract_transition', {
      repoPath,
      contractId,
      status: transitions[subcommand],
    }));
  }
  throw new CliError('invalid_args', 'usage: o8 contract list|propose|accept|verify|fail|supersede', EXIT.INVALID_ARGS);
}

export async function runSprint(mode: OutputMode, subcommand: string | undefined, rest: string[]): Promise<number> {
  const parsed = parseFlags(rest);
  const repoPath = value(parsed, 'repo') ?? process.cwd();
  if (subcommand === 'list') return output(mode, 'sprints', await harnessCall('sprint_list', { repoPath }));
  if (subcommand === 'start') {
    const contractId = parsed.positionals[0] ?? value(parsed, 'contract');
    if (!contractId) throw new CliError('invalid_args', 'o8 sprint start requires a contract id', EXIT.INVALID_ARGS);
    return output(mode, 'sprint started', await harnessCall('sprint_start', { repoPath, contractId }));
  }
  if (subcommand === 'tick') {
    const sprintId = parsed.positionals[0] ?? value(parsed, 'sprint');
    if (!sprintId) throw new CliError('invalid_args', 'o8 sprint tick requires a sprint id', EXIT.INVALID_ARGS);
    return output(mode, 'sprint tick', await harnessCall('sprint_tick', {
      repoPath,
      sprintId,
      note: value(parsed, 'note') ?? '',
    }));
  }
  throw new CliError('invalid_args', 'usage: o8 sprint list|start|tick', EXIT.INVALID_ARGS);
}

export async function runVerify(mode: OutputMode, rest: string[]): Promise<number> {
  const parsed = parseFlags(rest);
  const featureId = parsed.positionals[0] ?? value(parsed, 'feature');
  if (!featureId) throw new CliError('invalid_args', 'o8 verify requires a feature id', EXIT.INVALID_ARGS);
  return output(mode, 'verification', await harnessCall('verify', {
    repoPath: value(parsed, 'repo') ?? process.cwd(),
    ...(value(parsed, 'sprint') ? { sprintId: value(parsed, 'sprint') } : {}),
    note: value(parsed, 'note') ?? '',
    results: [{
      featureId,
      status: selectedCheckStatus(parsed),
      evidence: value(parsed, 'evidence') ?? '',
      ...(jsonCommand(parsed, 'command-json') ? { command: jsonCommand(parsed, 'command-json') } : {}),
      ...(numericValue(parsed, 'exit-code') !== undefined ? { exitCode: numericValue(parsed, 'exit-code') } : {}),
      ...(value(parsed, 'model') ? { modelId: value(parsed, 'model') } : {}),
    }],
  }));
}

export async function runHarness(mode: OutputMode, subcommand: string | undefined, rest: string[]): Promise<number> {
  if (subcommand === 'verify') return runVerify(mode, rest);
  const parsed = parseFlags(rest);
  const repoPath = value(parsed, 'repo') ?? process.cwd();
  if (subcommand === 'status') {
    return output(mode, 'harness status', await harnessCall('harness_status', {
      repoPath,
      ...(value(parsed, 'component') ? { componentKey: value(parsed, 'component') } : {}),
      ...(value(parsed, 'model') ? { modelId: value(parsed, 'model') } : {}),
    }));
  }
  if (subcommand === 'measure') {
    return output(mode, 'harness measurement', await harnessCall('harness_measure', {
      repoPath,
      componentKey: requiredValue(parsed, 'component'),
      modelId: requiredValue(parsed, 'model'),
      baselineScore: numericValue(parsed, 'baseline'),
      enabledScore: numericValue(parsed, 'enabled'),
      sampleCount: numericValue(parsed, 'samples'),
      evidence: jsonObject(parsed, 'evidence-json') ?? {},
    }));
  }
  if (subcommand === 'transition') {
    return output(mode, 'harness lifecycle', await harnessCall('harness_transition', {
      repoPath,
      componentKey: requiredValue(parsed, 'component'),
      modelId: requiredValue(parsed, 'model'),
      lifecycle: requiredValue(parsed, 'to'),
      reason: requiredValue(parsed, 'reason'),
    }));
  }
  if (subcommand === 'export') {
    const bundle = await harnessCall<unknown>('bundle_export', { repoPath });
    const outPath = value(parsed, 'out');
    if (outPath) {
      const resolved = resolve(outPath);
      writeFileSync(resolved, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      return output(mode, 'HarnessBundle exported', { schema: 'o8/cli/harness.export/v1', path: resolved });
    }
    return output(mode, 'HarnessBundle', bundle);
  }
  if (subcommand === 'import') {
    const file = requiredValue(parsed, 'file');
    let bundle: unknown;
    try {
      bundle = JSON.parse(readFileSync(resolve(file), 'utf8')) as unknown;
    } catch (error) {
      throw new CliError('invalid_bundle', `Unable to read bundle: ${error instanceof Error ? error.message : String(error)}`, EXIT.INVALID_ARGS);
    }
    return output(mode, 'HarnessBundle imported', await harnessCall('bundle_import', { repoPath, bundle }));
  }
  throw new CliError('invalid_args', 'usage: o8 harness status|measure|transition|verify|export|import', EXIT.INVALID_ARGS);
}

export async function runCapabilities(mode: OutputMode, rest: string[]): Promise<number> {
  const parsed = parseFlags(rest);
  return output(mode, 'harness capabilities', await harnessCall('capabilities', {
    ...(value(parsed, 'model') ? { modelId: value(parsed, 'model') } : {}),
  }));
}

function readDiff(parsed: ParsedFlags, repoPath: string): string {
  const diffFile = value(parsed, 'diff-file');
  if (diffFile) return readFileSync(resolve(diffFile), 'utf8');
  const base = value(parsed, 'base');
  const args = base
    ? ['-C', repoPath, 'diff', '--no-ext-diff', '--unified=80', `${base}...HEAD`]
    : ['-C', repoPath, 'diff', '--no-ext-diff', '--unified=80', 'HEAD'];
  try {
    return execFileSync('git', args, { windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    throw new CliError('diff_failed', `Unable to read git diff: ${error instanceof Error ? error.message : String(error)}`, EXIT.INVALID_ARGS);
  }
}

export async function runEvaluateDiff(mode: OutputMode, rest: string[]): Promise<number> {
  const parsed = parseFlags(rest);
  const repoPath = value(parsed, 'repo') ?? process.cwd();
  return output(mode, 'skeptic evaluation', await harnessCall('evaluate_diff', {
    repoPath,
    task: requiredValue(parsed, 'task'),
    diff: readDiff(parsed, repoPath),
    acceptanceCriteria: values(parsed, 'accept'),
  }, 600_000));
}
