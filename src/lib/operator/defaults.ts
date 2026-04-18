import 'server-only';

import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isThinkingEffort, type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';

/**
 * Operator defaults — the 7 dispatch/supervision knobs exposed in Settings.
 *
 * Resolution order (every knob): env var > persisted file > hardcoded fallback.
 *
 * Persisted file: `~/.cortex-ide/operator-defaults.json`
 * (override root with CORTEX_IDE_DATA_DIR).
 */

export type OverlapGateMode = 'advisory' | 'strict';
export type SettingSource = 'env' | 'file' | 'default';

export interface OperatorDefaults {
  parallelCap: number;
  overlapGate: OverlapGateMode;
  healBotEnabled: boolean;
  supervisorAutoEscalate: boolean;
  thinkingEffort: ThinkingEffort;
  promptCachingEnabled: boolean;
  orchestratorModel: string;
}

export interface OperatorDefaultsWithSources {
  values: OperatorDefaults;
  sources: Record<keyof OperatorDefaults, SettingSource>;
}

// ── Hardcoded fallbacks (the "locked defaults") ──

export const OPERATOR_DEFAULTS_FALLBACK: OperatorDefaults = {
  parallelCap: 5,
  overlapGate: 'advisory',
  healBotEnabled: true,
  supervisorAutoEscalate: false,
  thinkingEffort: 'adaptive',
  promptCachingEnabled: true,
  orchestratorModel: 'claude-opus-4-7',
};

export const PARALLEL_CAP_PRESETS: Array<{ key: 'conservative' | 'balanced' | 'power-user'; label: string; value: number }> = [
  { key: 'conservative', label: 'Conservative', value: 2 },
  { key: 'balanced', label: 'Balanced', value: 5 },
  { key: 'power-user', label: 'Power-user', value: 8 },
];

export const ORCHESTRATOR_MODEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'claude-opus-4-7', label: 'Opus 4.7' },
  { value: 'claude-opus-4-6', label: 'Opus 4.6' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

const OPERATOR_DEFAULTS_FILE = 'operator-defaults.json';

function getOperatorDefaultsPath() {
  return path.join(
    process.env.CORTEX_IDE_DATA_DIR || path.join(os.homedir(), '.cortex-ide'),
    OPERATOR_DEFAULTS_FILE,
  );
}

// ── Env overrides ──

function envParallelCap(): number | null {
  const raw = process.env.O8_MAX_PARALLEL_DISPATCHES;
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function envOverlapGate(): OverlapGateMode | null {
  const raw = process.env.O8_STRICT_OVERLAP_GATE;
  if (raw === '1') return 'strict';
  if (raw === '0') return 'advisory';
  return null;
}

function envSupervisorAutoEscalate(): boolean | null {
  const raw = process.env.O8_SUPERVISOR_AUTO_ESCALATE;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

function envHealBotEnabled(): boolean | null {
  const raw = process.env.O8_HEAL_BOT_ENABLED;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

function envPromptCachingEnabled(): boolean | null {
  const raw = process.env.O8_PROMPT_CACHING;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

function envThinkingEffort(): ThinkingEffort | null {
  const raw = process.env.O8_THINKING_EFFORT;
  if (raw && isThinkingEffort(raw)) return raw;
  return null;
}

function envOrchestratorModel(): string | null {
  const raw = process.env.O8_ORCHESTRATOR_MODEL;
  return raw?.trim() || null;
}

// ── File helpers ──

interface StoredOperatorDefaults {
  parallelCap?: number;
  overlapGate?: OverlapGateMode;
  healBotEnabled?: boolean;
  supervisorAutoEscalate?: boolean;
  thinkingEffort?: ThinkingEffort;
  promptCachingEnabled?: boolean;
  orchestratorModel?: string;
}

function parseStoredDefaults(raw: string): StoredOperatorDefaults {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as StoredOperatorDefaults;
    }
  } catch {
    // ignore malformed file
  }
  return {};
}

function isMissingFile(error: unknown) {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function resolveFromFile(stored: StoredOperatorDefaults): Partial<OperatorDefaults> {
  const result: Partial<OperatorDefaults> = {};
  if (typeof stored.parallelCap === 'number' && Number.isFinite(stored.parallelCap) && stored.parallelCap > 0) {
    result.parallelCap = Math.max(1, Math.min(32, Math.floor(stored.parallelCap)));
  }
  if (stored.overlapGate === 'advisory' || stored.overlapGate === 'strict') {
    result.overlapGate = stored.overlapGate;
  }
  if (typeof stored.healBotEnabled === 'boolean') {
    result.healBotEnabled = stored.healBotEnabled;
  }
  if (typeof stored.supervisorAutoEscalate === 'boolean') {
    result.supervisorAutoEscalate = stored.supervisorAutoEscalate;
  }
  if (stored.thinkingEffort && isThinkingEffort(stored.thinkingEffort)) {
    result.thinkingEffort = stored.thinkingEffort;
  }
  if (typeof stored.promptCachingEnabled === 'boolean') {
    result.promptCachingEnabled = stored.promptCachingEnabled;
  }
  if (typeof stored.orchestratorModel === 'string' && stored.orchestratorModel.trim()) {
    result.orchestratorModel = stored.orchestratorModel.trim();
  }
  return result;
}

// ── Resolution ──

function resolveDefaults(fileValues: Partial<OperatorDefaults>): OperatorDefaultsWithSources {
  const envCap = envParallelCap();
  const envGate = envOverlapGate();
  const envHeal = envHealBotEnabled();
  const envEsc = envSupervisorAutoEscalate();
  const envThink = envThinkingEffort();
  const envCache = envPromptCachingEnabled();
  const envModel = envOrchestratorModel();

  const resolved: OperatorDefaults = {
    parallelCap: envCap ?? fileValues.parallelCap ?? OPERATOR_DEFAULTS_FALLBACK.parallelCap,
    overlapGate: envGate ?? fileValues.overlapGate ?? OPERATOR_DEFAULTS_FALLBACK.overlapGate,
    healBotEnabled: envHeal ?? fileValues.healBotEnabled ?? OPERATOR_DEFAULTS_FALLBACK.healBotEnabled,
    supervisorAutoEscalate:
      envEsc ?? fileValues.supervisorAutoEscalate ?? OPERATOR_DEFAULTS_FALLBACK.supervisorAutoEscalate,
    thinkingEffort: envThink ?? fileValues.thinkingEffort ?? OPERATOR_DEFAULTS_FALLBACK.thinkingEffort,
    promptCachingEnabled:
      envCache ?? fileValues.promptCachingEnabled ?? OPERATOR_DEFAULTS_FALLBACK.promptCachingEnabled,
    orchestratorModel: envModel ?? fileValues.orchestratorModel ?? OPERATOR_DEFAULTS_FALLBACK.orchestratorModel,
  };

  const sources: Record<keyof OperatorDefaults, SettingSource> = {
    parallelCap: envCap !== null ? 'env' : fileValues.parallelCap !== undefined ? 'file' : 'default',
    overlapGate: envGate !== null ? 'env' : fileValues.overlapGate !== undefined ? 'file' : 'default',
    healBotEnabled: envHeal !== null ? 'env' : fileValues.healBotEnabled !== undefined ? 'file' : 'default',
    supervisorAutoEscalate:
      envEsc !== null ? 'env' : fileValues.supervisorAutoEscalate !== undefined ? 'file' : 'default',
    thinkingEffort: envThink !== null ? 'env' : fileValues.thinkingEffort !== undefined ? 'file' : 'default',
    promptCachingEnabled:
      envCache !== null ? 'env' : fileValues.promptCachingEnabled !== undefined ? 'file' : 'default',
    orchestratorModel: envModel !== null ? 'env' : fileValues.orchestratorModel !== undefined ? 'file' : 'default',
  };

  return { values: resolved, sources };
}

export async function getOperatorDefaults(): Promise<OperatorDefaultsWithSources> {
  let fileValues: Partial<OperatorDefaults> = {};
  try {
    const raw = await readFile(getOperatorDefaultsPath(), 'utf8');
    fileValues = resolveFromFile(parseStoredDefaults(raw));
  } catch (error) {
    if (!isMissingFile(error)) {
      console.error('[operator-defaults] Failed to read operator defaults:', error);
    }
  }
  return resolveDefaults(fileValues);
}

export function getOperatorDefaultsSync(): OperatorDefaultsWithSources {
  let fileValues: Partial<OperatorDefaults> = {};
  try {
    const raw = readFileSync(getOperatorDefaultsPath(), 'utf8');
    fileValues = resolveFromFile(parseStoredDefaults(raw));
  } catch (error) {
    if (!isMissingFile(error)) {
      console.error('[operator-defaults] Failed to read operator defaults during sync read:', error);
    }
  }
  return resolveDefaults(fileValues);
}

export async function updateOperatorDefaults(update: Partial<OperatorDefaults>): Promise<OperatorDefaultsWithSources> {
  const filePath = getOperatorDefaultsPath();
  let stored: StoredOperatorDefaults = {};

  try {
    const raw = await readFile(filePath, 'utf8');
    stored = parseStoredDefaults(raw);
  } catch (error) {
    if (!isMissingFile(error)) {
      console.error('[operator-defaults] Failed to read existing operator defaults before write:', error);
    }
  }

  if (update.parallelCap !== undefined) {
    if (!Number.isFinite(update.parallelCap) || update.parallelCap < 1) {
      throw new Error('parallelCap must be a positive number.');
    }
    stored.parallelCap = Math.max(1, Math.min(32, Math.floor(update.parallelCap)));
  }
  if (update.overlapGate !== undefined) {
    if (update.overlapGate !== 'advisory' && update.overlapGate !== 'strict') {
      throw new Error('overlapGate must be "advisory" or "strict".');
    }
    stored.overlapGate = update.overlapGate;
  }
  if (update.healBotEnabled !== undefined) {
    stored.healBotEnabled = Boolean(update.healBotEnabled);
  }
  if (update.supervisorAutoEscalate !== undefined) {
    stored.supervisorAutoEscalate = Boolean(update.supervisorAutoEscalate);
  }
  if (update.thinkingEffort !== undefined) {
    if (!isThinkingEffort(update.thinkingEffort)) {
      throw new Error('thinkingEffort must be a valid ThinkingEffort value.');
    }
    stored.thinkingEffort = update.thinkingEffort;
  }
  if (update.promptCachingEnabled !== undefined) {
    stored.promptCachingEnabled = Boolean(update.promptCachingEnabled);
  }
  if (update.orchestratorModel !== undefined) {
    const trimmed = update.orchestratorModel.trim();
    if (!trimmed) {
      throw new Error('orchestratorModel cannot be empty.');
    }
    stored.orchestratorModel = trimmed;
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');

  return getOperatorDefaults();
}

/**
 * Synchronously resolve one common knob.
 * Used by scheduling.ts module-init code that must not do async work.
 */
export function resolveParallelCapSync(): number {
  return getOperatorDefaultsSync().values.parallelCap;
}

export function resolveOverlapGateSync(): OverlapGateMode {
  return getOperatorDefaultsSync().values.overlapGate;
}

export function resolveSupervisorAutoEscalateSync(): boolean {
  return getOperatorDefaultsSync().values.supervisorAutoEscalate;
}

export function resolveHealBotEnabledSync(): boolean {
  return getOperatorDefaultsSync().values.healBotEnabled;
}

export function resolvePromptCachingEnabledSync(): boolean {
  return getOperatorDefaultsSync().values.promptCachingEnabled;
}
