import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parse, stringify } from 'smol-toml';

import { isPlausibleAcpModelId } from '@/lib/orchestrator/acp-model-id';

import {
  CODEX_MODEL_IDS,
  isCodexModelId,
  isSupportedModelId,
  SUPPORTED_MODEL_IDS,
} from '@/lib/models';
import type { OperatorDefaults } from '@/lib/operator/defaults';
import {
  isClassAComposer,
  isCollideAggregator,
  isDispatchRuntime,
  isOrchestratorBackendSetting,
  isPrLinkDestination,
  isReviewerBackendSetting,
  isWorkersUseBrain,
  sanitizeBranchPrefix,
} from '@/lib/operator/defaults-env';
import { isSubscriptionProfile } from '@/lib/operator/subscription-profile';
import { isTargetingTier } from '@/lib/operator/targeting-tier';
import { isThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { AUTHENTICATED_ENDPOINT_GUIDANCE, credentialBearingUrlPart } from './credential-safe-url';

type TomlRecord = Record<string, unknown>;

interface TomlField<T> {
  path: readonly [string, string];
  parse: (value: unknown, key: string) => T;
  /**
   * How the value is written back to TOML, when that differs from `parse`.
   * TOML has no null, so a nullable field whose value is null would be dropped
   * by stringify and then vanish from the reparsed key set. Such fields
   * serialize null as "" and parse "" back to null.
   */
  serialize?: (value: T) => unknown;
}

function invalid(key: string, expected: string): never {
  throw new SettingsTomlValidationError(key, expected);
}

function booleanField(section: string, key: string): TomlField<boolean> {
  return {
    path: [section, key],
    parse: (value, tomlKey) => typeof value === 'boolean' ? value : invalid(tomlKey, 'a boolean'),
  };
}

function stringField(section: string, key: string, options: { nonEmpty?: boolean } = {}): TomlField<string> {
  return {
    path: [section, key],
    parse: (value, tomlKey) => {
      if (typeof value !== 'string') return invalid(tomlKey, 'a string');
      const trimmed = value.trim();
      if (options.nonEmpty && !trimmed) return invalid(tomlKey, 'a non-empty string');
      return trimmed;
    },
  };
}

function orchestratorModelField(section: string, key: string): TomlField<OperatorDefaults['orchestratorModel']> {
  return {
    path: [section, key],
    parse: (value, tomlKey) => {
      if (typeof value !== 'string') return invalid(tomlKey, 'a supported model id string');
      const trimmed = value.trim();
      return isSupportedModelId(trimmed)
        ? trimmed
        : invalid(tomlKey, `a supported model id; received ${JSON.stringify(trimmed)}; valid values are ${SUPPORTED_MODEL_IDS.map((model) => JSON.stringify(model)).join(', ')}`);
    },
  };
}

function codexModelField(section: string, key: string): TomlField<OperatorDefaults['brainCodexModel']> {
  return {
    path: [section, key],
    parse: (value, tomlKey) => {
      if (typeof value !== 'string') return invalid(tomlKey, 'a supported Codex model id string');
      const trimmed = value.trim();
      return isCodexModelId(trimmed)
        ? trimmed
        : invalid(tomlKey, `a supported Codex model id; received ${JSON.stringify(trimmed)}; valid values are ${CODEX_MODEL_IDS.map((model) => JSON.stringify(model)).join(', ')}`);
    },
  };
}

/**
 * A DISCOVERED model id (opencode/ACP). Unlike orchestratorModelField this
 * cannot check membership in SUPPORTED_MODEL_IDS — the valid set lives in the
 * operator's agent, not in this repo — so it validates shape only. An empty
 * string means "no pin, use the agent's own default" and parses to null.
 */
function acpModelIdField(section: string, key: string): TomlField<string | null> {
  return {
    path: [section, key],
    // "" is the on-disk spelling of "unset" — see TomlField.serialize.
    serialize: (value) => value ?? '',
    parse: (value, tomlKey) => {
      if (value === null) return null;
      if (typeof value !== 'string') return invalid(tomlKey, 'a model id string');
      const trimmed = value.trim();
      if (!trimmed) return null;
      return isPlausibleAcpModelId(trimmed)
        ? trimmed
        : invalid(tomlKey, `a model id shaped provider/model, optionally with a /low or /high suffix; received ${JSON.stringify(trimmed)}`);
    },
  };
}

function credentialSafeUrlField(section: string, key: string): TomlField<string> {
  return {
    path: [section, key],
    parse: (value, tomlKey) => {
      if (typeof value !== 'string') return invalid(tomlKey, 'a string URL');
      const trimmed = value.trim();
      const part = credentialBearingUrlPart(trimmed);
      return part
        ? invalid(tomlKey, `a URL without credential-bearing ${part}; ${AUTHENTICATED_ENDPOINT_GUIDANCE}`)
        : trimmed;
    },
  };
}

function numberField(
  section: string,
  key: string,
  expected: string,
  accept: (value: number) => boolean,
  normalize: (value: number) => number = (value) => value,
): TomlField<number> {
  return {
    path: [section, key],
    parse: (value, tomlKey) => typeof value === 'number' && Number.isFinite(value) && accept(value)
      ? normalize(value)
      : invalid(tomlKey, expected),
  };
}

function enumField<T>(
  section: string,
  key: string,
  expected: string,
  predicate: (value: unknown) => value is T,
): TomlField<T> {
  return {
    path: [section, key],
    parse: (value, tomlKey) => predicate(value) ? value : invalid(tomlKey, expected),
  };
}

function dispatchRuntimeListField(section: string, key: string): TomlField<OperatorDefaults['workerRuntimes']> {
  return {
    path: [section, key],
    parse: (value, tomlKey) => Array.isArray(value) && value.length > 0 && value.every(isDispatchRuntime)
      ? [...new Set(value)]
      : invalid(tomlKey, 'a non-empty array of dispatchable runtime names'),
  };
}

function branchPrefixField(section: string, key: string): TomlField<string> {
  return {
    path: [section, key],
    parse: (value, tomlKey) => {
      if (typeof value !== 'string') return invalid(tomlKey, 'a branch-safe string');
      const trimmed = value.trim();
      const sanitized = sanitizeBranchPrefix(trimmed);
      return sanitized && sanitized === trimmed
        ? trimmed
        : invalid(tomlKey, 'a non-empty branch-safe prefix');
    },
  };
}

function targetingTierField(section: string, key: string): TomlField<OperatorDefaults['targetingTriage']> {
  return {
    path: [section, key],
    parse: (value, tomlKey) => isTargetingTier(value)
      ? value
      : invalid(tomlKey, 'a table with dispatchable runtime, string model, and valid thinking effort'),
  };
}

/**
 * The exhaustive config-as-code contract. `satisfies` fails at compile time if
 * OperatorDefaults gains a key without a TOML mapping; the runtime coverage
 * test guards the same seam when this object is changed through untyped code.
 */
export const OPERATOR_DEFAULTS_TOML_MAPPING = {
  subscriptionProfile: enumField('operator', 'subscription_profile', 'one of "both", "claude-only", or "codex-only"', isSubscriptionProfile),
  parallelCap: numberField('operator', 'parallel_cap', 'an integer between 1 and 32', (value) => Number.isInteger(value) && value >= 1 && value <= 32),
  overlapGate: enumField('operator', 'overlap_gate', '"advisory" or "strict"', (value): value is OperatorDefaults['overlapGate'] => value === 'advisory' || value === 'strict'),
  healBotEnabled: booleanField('operator', 'heal_bot_enabled'),
  supervisorAutoEscalate: booleanField('operator', 'supervisor_auto_escalate'),
  reviewContinuation: booleanField('review', 'continuation_enabled'),
  thinkingEffort: enumField('models', 'thinking_effort', 'a valid thinking effort', isThinkingEffort),
  promptCachingEnabled: booleanField('models', 'prompt_caching_enabled'),
  mergeTestReplayEnabled: booleanField('review', 'merge_test_replay_enabled'),
  requireApproval: enumField('review', 'require_approval', 'one of "high-risk", "surface", "always", or "never"', (value): value is OperatorDefaults['requireApproval'] => value === 'high-risk' || value === 'surface' || value === 'always' || value === 'never'),
  orchestratorModel: orchestratorModelField('models', 'orchestrator_model'),
  opencodeOrchestratorModel: acpModelIdField('models', 'opencode_orchestrator_model'),
  opencodeWorkerModel: acpModelIdField('models', 'opencode_worker_model'),
  defaultDispatchRuntime: enumField('models', 'default_dispatch_runtime', 'a dispatchable runtime name', isDispatchRuntime),
  workerRuntimes: dispatchRuntimeListField('models', 'worker_runtimes'),
  codexWorkerEffort: enumField('models', 'codex_worker_effort', 'a valid thinking effort', isThinkingEffort),
  claudeWorkerEffort: enumField('models', 'claude_worker_effort', 'a valid thinking effort', isThinkingEffort),
  brainCodexModel: codexModelField('brain', 'codex_model'),
  brainCodexEffort: enumField('brain', 'codex_effort', 'a valid thinking effort', isThinkingEffort),
  defaultDispatchModel: stringField('models', 'default_dispatch_model'),
  localInferenceBaseUrl: credentialSafeUrlField('local_models', 'inference_base_url'),
  localEmbedModel: stringField('local_models', 'embed_model'),
  localChatModel: stringField('local_models', 'chat_model'),
  experimentalOpencode: booleanField('experimental', 'opencode_enabled'),
  experimentalGemini: booleanField('experimental', 'gemini_enabled'),
  experimentalChat: booleanField('experimental', 'chat_enabled'),
  experimentalCanvas: booleanField('experimental', 'canvas_enabled'),
  nativeBrowserView: booleanField('experimental', 'native_browser_view'),
  classAComposer: enumField('brain', 'class_a_composer', 'one of "auto", "haiku-cli", "sonnet-cli", or "fastest"', isClassAComposer),
  inAppOrchestratorEnabled: booleanField('orchestrator', 'legacy_claude_enabled'),
  brainUseClaudeCli: booleanField('brain', 'use_claude_cli'),
  workersUseBrain: enumField('brain', 'workers_use_brain', 'one of "off", "auto", or "all"', isWorkersUseBrain),
  crossHouseWorkerFallback: booleanField('models', 'cross_house_worker_fallback'),
  orchestratorBackend: enumField('orchestrator', 'backend', 'a supported orchestrator backend', isOrchestratorBackendSetting),
  reviewerBackend: enumField('review', 'backend', 'one of "follow", "codex", or "claude"', isReviewerBackendSetting),
  packetExplainerEnabled: booleanField('review', 'packet_explainer_enabled'),
  quizGateEnabled: booleanField('review', 'quiz_gate_enabled'),
  buyinDocEnabled: booleanField('review', 'buyin_doc_enabled'),
  targetingTriage: targetingTierField('targeting', 'triage'),
  targetingAction: targetingTierField('targeting', 'action'),
  updateAutoApply: enumField('operator', 'update_auto_apply', '"off" or "idle"', (value): value is OperatorDefaults['updateAutoApply'] => value === 'off' || value === 'idle'),
  collideAggregator: enumField('orchestrator', 'collide_aggregator', 'one of "auto", "claude", or "codex"', isCollideAggregator),
  productTelemetryEnabled: booleanField('telemetry', 'product_enabled'),
  telemetryConsentAnswered: booleanField('telemetry', 'consent_answered'),
  telemetryOptIn: booleanField('telemetry', 'crash_log_opt_in'),
  telemetryIngestUrl: credentialSafeUrlField('telemetry', 'ingest_url'),
  crashReportsEnabled: booleanField('telemetry', 'sentry_enabled'),
  branchPrefix: branchPrefixField('git', 'branch_prefix'),
  commitAttributionEnabled: booleanField('git', 'commit_attribution_enabled'),
  prLinkDestination: enumField('git', 'pr_link_destination', '"in-app" or "browser"', isPrLinkDestination),
  worktreeMaxCount: numberField('git', 'worktree_max_count', 'an integer between 0 and 1000', (value) => Number.isInteger(value) && value >= 0 && value <= 1000),
  worktreeMaxTotalGb: numberField('git', 'worktree_max_total_gb', 'a number between 0 and 10000', (value) => value >= 0 && value <= 10000),
} satisfies { [K in keyof OperatorDefaults]: TomlField<OperatorDefaults[K]> };

export const OPERATOR_DEFAULTS_TOML_KEYS = Object.freeze(
  Object.keys(OPERATOR_DEFAULTS_TOML_MAPPING) as Array<keyof OperatorDefaults>,
);

export class SettingsTomlParseError extends Error {
  constructor(message: string) {
    super(`settings.toml could not be parsed: ${message}`);
    this.name = 'SettingsTomlParseError';
  }
}

export class SettingsTomlValidationError extends Error {
  readonly key: string;

  constructor(key: string, expected: string) {
    super(`${key} expected ${expected}.`);
    this.name = 'SettingsTomlValidationError';
    this.key = key;
  }
}

function isRecord(value: unknown): value is TomlRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseDocument(raw: string): TomlRecord {
  try {
    const parsed = parse(raw);
    if (!isRecord(parsed)) throw new Error('the document root must be a table');
    return parsed;
  } catch (error) {
    if (error instanceof SettingsTomlParseError) throw error;
    const message = error instanceof Error ? error.message : 'unknown syntax error';
    throw new SettingsTomlParseError(message);
  }
}

function readPath(document: TomlRecord, field: TomlField<unknown>): unknown {
  const [section, key] = field.path;
  const table = document[section];
  if (table === undefined) return undefined;
  if (!isRecord(table)) invalid(section, 'a table');
  return table[key];
}

function writePath(document: TomlRecord, field: TomlField<unknown>, value: unknown): void {
  const [section, key] = field.path;
  const current = document[section];
  if (current !== undefined && !isRecord(current)) invalid(section, 'a table');
  const table = current ?? {};
  const existingValue = (table as TomlRecord)[key];
  (table as TomlRecord)[key] = isRecord(existingValue) && isRecord(value)
    ? { ...existingValue, ...value }
    : value;
  document[section] = table;
}

export function parseOperatorDefaultsToml(raw: string): Partial<OperatorDefaults> {
  const document = parseDocument(raw);
  const values: Partial<OperatorDefaults> = {};

  for (const operatorKey of OPERATOR_DEFAULTS_TOML_KEYS) {
    // Double cast: `serialize` makes TomlField contravariant in T, so a direct
    // widening cast is (correctly) rejected. The loop only ever pairs a field
    // with its own key, so erasing the parameter type here is sound.
    const field = OPERATOR_DEFAULTS_TOML_MAPPING[operatorKey] as unknown as TomlField<unknown>;
    const rawValue = readPath(document, field);
    if (rawValue === undefined) continue;
    const tomlKey = field.path.join('.');
    (values as Record<string, unknown>)[operatorKey] = field.parse(rawValue, tomlKey);
  }

  return values;
}

/**
 * Re-parsing the existing document keeps every unknown key/table in the object
 * passed to smol-toml. smol-toml does not expose comment AST nodes, so comments
 * cannot survive a GUI-originated stringify; direct editor saves remain exact.
 */
export function serializeOperatorDefaultsToml(
  values: Partial<OperatorDefaults>,
  existingRaw?: string,
): string {
  const document = existingRaw === undefined ? {} : parseDocument(existingRaw);
  for (const operatorKey of OPERATOR_DEFAULTS_TOML_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(values, operatorKey)) continue;
    const field = OPERATOR_DEFAULTS_TOML_MAPPING[operatorKey] as unknown as TomlField<unknown>;
    const tomlKey = field.path.join('.');
    const parsed = field.parse(values[operatorKey], tomlKey);
    writePath(document, field, field.serialize ? field.serialize(parsed) : parsed);
  }
  return stringify(document);
}

export async function writeFileAtomic(
  filePath: string,
  content: string,
  beforeRename?: () => Promise<void>,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, content, { encoding: 'utf8', flag: 'wx' });
    await beforeRename?.();
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}
