import 'server-only';

import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isThinkingEffort, type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';

const DISPATCH_RUNTIMES: OrchestratorRuntime[] = ['codex', 'claude-code', 'gemini', 'opencode'];
function isDispatchRuntime(value: unknown): value is OrchestratorRuntime {
  return typeof value === 'string' && (DISPATCH_RUNTIMES as string[]).includes(value);
}

/**
 * Operator defaults — the dispatch/supervision knobs exposed in Settings
 * (one field per knob in {@link OperatorDefaults}; the count grows, don't
 * hardcode it in docs).
 *
 * Resolution order (every knob): env var > persisted file > hardcoded fallback.
 *
 * Persisted file: `~/.cortex-ide/operator-defaults.json`
 * (override root with CORTEX_IDE_DATA_DIR).
 */

export type OverlapGateMode = 'advisory' | 'strict';
export type SettingSource = 'env' | 'file' | 'default';

/**
 * Q&A Class A composer routing (#971, 'fastest' added #1124-era perf pass).
 *   - `auto` / `haiku-cli` — current chain: Haiku CLI tier 1, then Codex/OpenRouter/Flash/Sonnet CLI fallbacks.
 *   - `sonnet-cli` — lead with Sonnet CLI for higher quality. Skips Haiku + Codex tiers.
 *   - `fastest` — lead with OpenRouter flash-lite (~1-3s, pennies, daily-capped), free tiers as fallback.
 * Eval-mode (smoke gate) is unaffected — always routes through OpenRouter Sonnet 4.6.
 */
export type ClassAComposer = 'auto' | 'haiku-cli' | 'sonnet-cli' | 'fastest';

function isClassAComposer(value: unknown): value is ClassAComposer {
  // 'fastest' was missing here after #1124 added it to the type — Settings
  // could offer it but updateOperatorDefaults rejected the write.
  return value === 'auto' || value === 'haiku-cli' || value === 'sonnet-cli' || value === 'fastest';
}

/**
 * "Workers use the Brain" (2026-06-11). Whether dispatched worker agents get
 * Engineering Brain access (`o8 ask`) injected into their packet prompt.
 *   - `off`  — workers never told about the Brain.
 *   - `auto` — Brain on for NON-frontier runtimes only (tier !== 'frontier'
 *     in runtime-capabilities). Codex GPT-5.5 stays lean; weaker + future
 *     local models get repo knowledge without burning context on searches.
 *   - `all`  — every worker gets it (the dogfood / A-B setting).
 * Per-packet `useBrain` overrides this either way.
 */
export type WorkersUseBrain = 'off' | 'auto' | 'all';

function isWorkersUseBrain(value: unknown): value is WorkersUseBrain {
  return value === 'off' || value === 'auto' || value === 'all';
}

/** Which backend drives the in-app Orchestrator. 'auto' = the legacy
 *  inAppOrchestratorEnabled derivation; a specific id forces that backend. */
export type OrchestratorBackendSetting = 'auto' | 'codex' | 'claude' | 'openclaw' | 'hermes';

function isOrchestratorBackendSetting(value: unknown): value is OrchestratorBackendSetting {
  return value === 'auto' || value === 'codex' || value === 'claude' || value === 'openclaw' || value === 'hermes';
}

export interface OperatorDefaults {
  parallelCap: number;
  overlapGate: OverlapGateMode;
  healBotEnabled: boolean;
  supervisorAutoEscalate: boolean;
  thinkingEffort: ThinkingEffort;
  promptCachingEnabled: boolean;
  orchestratorModel: string;
  defaultDispatchRuntime: OrchestratorRuntime;
  /**
   * Default model for DISPATCHED workers. Empty = let the runtime pick its own
   * default (today: Codex's configured model). Set it to a LOCAL model with the
   * `ollama:<model>` / `lmstudio:<model>` convention (see
   * src/lib/codex/local-model.ts) to run every worker on your own machine —
   * scoped to o8 workers; your interactive Codex is untouched. A per-mission
   * model still overrides this. Env: `O8_DISPATCH_MODEL`.
   */
  defaultDispatchModel: string;
  /**
   * Local inference endpoint — the OpenAI-compatible base URL of a local model
   * server (Ollama `http://localhost:11434`, LM Studio `http://localhost:1234`,
   * or any custom host root, NO trailing /v1). Empty = use cloud. When set with
   * `localEmbedModel`, the Brain embeds here instead of OpenAI — a zero-cloud-key
   * local dev. Env: `O8_LOCAL_INFERENCE_BASE_URL`.
   */
  localInferenceBaseUrl: string;
  /** Embedding model on the local endpoint for the Brain (e.g. `nomic-embed-text`).
   *  Empty = no local embeddings (Brain uses BM25/exact-match). Env: `O8_LOCAL_EMBED_MODEL`. */
  localEmbedModel: string;
  /** Chat model on the local endpoint for Brain compose/classify + dictation polish.
   *  Empty = cloud/managed path. Env: `O8_LOCAL_CHAT_MODEL`. */
  localChatModel: string;
  /**
   * Off by default for v1. When true, opencode shows up in the dispatch
   * runtime picker + packet runtime dropdown + command palette. Kept as an
   * opt-in while we dogfood the adapter with early users; the owned-session
   * store stays wired either way so existing opencode lanes keep working
   * even after the flag flips off.
   */
  experimentalOpencode: boolean;
  /**
   * Off by default — Gemini is hidden from the dispatch + CLI pickers for v1
   * (we ship Claude + Codex). Mirrors `experimentalOpencode`: flip on to
   * surface Gemini again. The adapter stays wired either way so existing
   * Gemini lanes keep working even with the flag off.
   */
  experimentalGemini: boolean;
  /**
   * Off by default for alpha. The casual `llm-chat` ("o8 Default" assistant)
   * tab is fully wired but hidden from the UI — the orchestrator is the only
   * conversational surface until this flips on. Mirrors `experimentalGemini`:
   * existing llm-chat tabs + the model picker stay wired, just unsurfaced.
   */
  experimentalChat: boolean;
  /**
   * Off by default. The `fleet-canvas` workspace tab — live packet cards on
   * a spatial canvas (docs/canvas-mode-plan.md). Flag ON surfaces a Canvas
   * row in the New-tab picker; flag OFF hides the row AND any existing
   * fleet-canvas tabs (mirrors `experimentalChat`: tab data stays persisted
   * for when it flips back on).
   */
  experimentalCanvas: boolean;
  /** Native browser-view: render the embedded Browser pane in a host-owned child
   *  WebviewWindow (origin-sensitive auth apps render natively + stay
   *  agent-grabbable) instead of the iframe/proxy + engine-JPEG fallback.
   *  On by default; the iframe path is the fallback when off. macOS desktop only. */
  nativeBrowserView: boolean;
  /**
   * Q&A Class A composer model (#971). Production-only knob — eval mode keeps
   * its OpenRouter Sonnet 4.6 path either way.
   */
  classAComposer: ClassAComposer;
  /**
   * In-app orchestrator chat — the assistant panel that drives the
   * orchestrator session. **On by default as of v0.1.152.** Spawns
   * `claude --input-format stream-json` (no `-p`) so every turn bills
   * against the user's Claude Code MAX subscription pool — the same line
   * `claude` in Terminal uses, NOT the gated Agent SDK pool. Requires the
   * `claude` CLI to be installed and signed in; the spawn will error if
   * it's missing. Flip off to fall back to Codex GPT-5.5 xhigh as the
   * orchestrator brain (free for ChatGPT Plus / Codex subscribers).
   */
  inAppOrchestratorEnabled: boolean;
  /**
   * Engineering Brain — may it use the Claude CLI warm pool (Haiku/Sonnet) for
   * classify + compose. **On by default.** This is DECOUPLED from
   * {@link inAppOrchestratorEnabled} on purpose (2026-06-22): the orchestrator
   * toggle is about which model drives orchestration; this is purely "can the
   * Brain answer via the warm sub-billed Claude CLI." Before the split, running
   * Codex as the orchestrator (inAppOrchestratorEnabled=false) silently forced
   * the Brain off its fast ~2.7s warm-Haiku path. Subscription-billed (the warm
   * REPL pool, no `-p`); degrades gracefully to the rest of the cascade when the
   * `claude` CLI is missing or signed out. Flip off to keep the Brain on
   * OpenRouter/Codex/heuristic only.
   */
  brainUseClaudeCli: boolean;
  /** See {@link WorkersUseBrain}. Default 'auto'. */
  workersUseBrain: WorkersUseBrain;
  /**
   * Which backend drives the in-app Orchestrator. **'auto' (default)** = the
   * legacy derivation from {@link inAppOrchestratorEnabled} (toggle ON → Claude,
   * OFF → Codex), byte-identical to pre-setting behavior. A specific value forces
   * that backend — including **'openclaw'** (the governed openclaw orchestrator,
   * previously reachable only via a per-request mobile `backend` field). A
   * per-request `msg.backend` still overrides this. Env: `O8_ORCHESTRATOR_BACKEND`.
   */
  orchestratorBackend: OrchestratorBackendSetting;
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
  // Operator-pinned: Opus 4.8 with max thinking is the default orchestrator
  // brain. Subscription-billed via the REPL migration, so cost is the user's
  // existing Claude Code MAX plan — not a per-token API charge.
  thinkingEffort: 'max',
  promptCachingEnabled: true,
  orchestratorModel: 'claude-opus-4-8',
  defaultDispatchRuntime: 'codex',
  defaultDispatchModel: '',
  localInferenceBaseUrl: '',
  localEmbedModel: '',
  localChatModel: '',
  experimentalOpencode: false,
  experimentalGemini: false,
  experimentalChat: false,
  experimentalCanvas: false,
  nativeBrowserView: true,
  classAComposer: 'auto',
  // ON by default post-#1097. Subscription pool, not Agent SDK pool. See the
  // docstring above on the field for the rationale.
  inAppOrchestratorEnabled: true,
  // ON by default — the free, fast (~2.7s warm), subscription-billed Brain for
  // anyone with a Claude sub. Independent of the orchestrator toggle (2026-06-22).
  brainUseClaudeCli: true,
  workersUseBrain: 'auto',
  // 'auto' → defer to inAppOrchestratorEnabled (legacy claude/codex derivation),
  // so the default is byte-identical to pre-setting behavior.
  orchestratorBackend: 'auto',
};

export const CLASS_A_COMPOSER_OPTIONS: Array<{ value: ClassAComposer; label: string; detail: string }> = [
  { value: 'haiku-cli', label: 'Haiku', detail: 'Free for Claude Max users via the warm REPL pool.' },
  { value: 'sonnet-cli', label: 'Sonnet', detail: 'Best quality, free, slower bootstrap.' },
  { value: 'fastest', label: 'Fastest', detail: 'OpenRouter flash-lite first (~1-3s, pennies per question, daily-capped). Free tiers as fallback.' },
];

export const DISPATCH_RUNTIME_OPTIONS: Array<{ value: OrchestratorRuntime; label: string; detail: string }> = [
  { value: 'codex', label: 'Codex', detail: 'OpenAI CLI — the default workhorse.' },
  { value: 'claude-code', label: 'Claude Code', detail: 'Anthropic CLI — use when you have a Claude sub.' },
  { value: 'gemini', label: 'Gemini', detail: 'Google Gemini 3.1 Pro CLI — fastest for parallel fan-out.' },
  { value: 'opencode', label: 'opencode', detail: 'OSS CLI — routes through your configured provider keys.' },
];

export const ORCHESTRATOR_BACKEND_OPTIONS: Array<{ value: OrchestratorBackendSetting; label: string; detail: string }> = [
  { value: 'auto', label: 'Auto', detail: 'Follow the in-app orchestrator toggle below (Claude when on, Codex when off).' },
  { value: 'codex', label: 'Codex', detail: 'Codex GPT-5.5 xhigh — free for ChatGPT Plus / Codex subscribers.' },
  { value: 'claude', label: 'Claude', detail: 'Claude Code REPL — subscription-billed (Claude Max pool).' },
  { value: 'openclaw', label: 'OpenClaw', detail: 'Governed openclaw orchestrator — dispatches Codex workers through o8.' },
  { value: 'hermes', label: 'Hermes', detail: 'Hermes via ACP — needs Hermes installed + a model provider configured (hermes setup).' },
];

export const PARALLEL_CAP_PRESETS: Array<{ key: 'conservative' | 'balanced' | 'power-user'; label: string; value: number }> = [
  { key: 'conservative', label: 'Conservative', value: 2 },
  { key: 'balanced', label: 'Balanced', value: 5 },
  { key: 'power-user', label: 'Power-user', value: 8 },
];

export const ORCHESTRATOR_MODEL_OPTIONS: Array<{ value: string; label: string }> = [
  // Subscription-billed via the claude CLI like every other entry. Fable is
  // included in Claude Code MAX subscriptions through 2026-06-22.
  { value: 'claude-fable-5', label: 'Fable 5' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-opus-4-7', label: 'Opus 4.7' },
  { value: 'claude-opus-4-6', label: 'Opus 4.6' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

const OPERATOR_DEFAULTS_FILE = 'operator-defaults.json';

function getOperatorDefaultsPath() {
  return path.join(
    process.env.CORTEX_IDE_DATA_DIR || path.join(os.homedir(), '.o8'),
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

function envDefaultDispatchRuntime(): OrchestratorRuntime | null {
  const raw = process.env.O8_DEFAULT_DISPATCH_RUNTIME?.trim();
  if (!raw) return null;
  if (isDispatchRuntime(raw)) return raw;
  return null;
}

function envDefaultDispatchModel(): string | null {
  const raw = process.env.O8_DISPATCH_MODEL;
  return raw?.trim() || null;
}

function envLocalInferenceBaseUrl(): string | null {
  return process.env.O8_LOCAL_INFERENCE_BASE_URL?.trim() || null;
}

function envLocalEmbedModel(): string | null {
  return process.env.O8_LOCAL_EMBED_MODEL?.trim() || null;
}

function envLocalChatModel(): string | null {
  return process.env.O8_LOCAL_CHAT_MODEL?.trim() || null;
}

function envExperimentalOpencode(): boolean | null {
  const raw = process.env.O8_EXPERIMENTAL_OPENCODE;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

function envExperimentalGemini(): boolean | null {
  const raw = process.env.O8_EXPERIMENTAL_GEMINI;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

function envExperimentalChat(): boolean | null {
  const raw = process.env.O8_EXPERIMENTAL_CHAT;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

function envExperimentalCanvas(): boolean | null {
  const raw = process.env.O8_EXPERIMENTAL_CANVAS;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

function envNativeBrowserView(): boolean | null {
  const raw = process.env.O8_NATIVE_BROWSER_VIEW;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

function envClassAComposer(): ClassAComposer | null {
  const raw = process.env.O8_CLASS_A_COMPOSER?.trim();
  if (raw && isClassAComposer(raw)) return raw;
  return null;
}

function envInAppOrchestratorEnabled(): boolean | null {
  const raw = process.env.O8_IN_APP_ORCHESTRATOR_ENABLED;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

function envBrainUseClaudeCli(): boolean | null {
  const raw = process.env.O8_BRAIN_USE_CLAUDE_CLI;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

function envWorkersUseBrain(): WorkersUseBrain | null {
  const raw = process.env.O8_WORKERS_USE_BRAIN?.trim();
  if (raw && isWorkersUseBrain(raw)) return raw;
  return null;
}

function envOrchestratorBackend(): OrchestratorBackendSetting | null {
  const raw = process.env.O8_ORCHESTRATOR_BACKEND?.trim();
  if (raw && isOrchestratorBackendSetting(raw)) return raw;
  return null;
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
  defaultDispatchRuntime?: OrchestratorRuntime;
  defaultDispatchModel?: string;
  localInferenceBaseUrl?: string;
  localEmbedModel?: string;
  localChatModel?: string;
  experimentalOpencode?: boolean;
  experimentalGemini?: boolean;
  experimentalChat?: boolean;
  experimentalCanvas?: boolean;
  nativeBrowserView?: boolean;
  classAComposer?: ClassAComposer;
  inAppOrchestratorEnabled?: boolean;
  brainUseClaudeCli?: boolean;
  workersUseBrain?: WorkersUseBrain;
  orchestratorBackend?: OrchestratorBackendSetting;
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
  if (isDispatchRuntime(stored.defaultDispatchRuntime)) {
    result.defaultDispatchRuntime = stored.defaultDispatchRuntime;
  }
  if (typeof stored.defaultDispatchModel === 'string') {
    // Empty string is meaningful here ("unset → runtime default"), so accept it.
    result.defaultDispatchModel = stored.defaultDispatchModel.trim();
  }
  if (typeof stored.localInferenceBaseUrl === 'string') {
    result.localInferenceBaseUrl = stored.localInferenceBaseUrl.trim();
  }
  if (typeof stored.localEmbedModel === 'string') {
    result.localEmbedModel = stored.localEmbedModel.trim();
  }
  if (typeof stored.localChatModel === 'string') {
    result.localChatModel = stored.localChatModel.trim();
  }
  if (typeof stored.experimentalOpencode === 'boolean') {
    result.experimentalOpencode = stored.experimentalOpencode;
  }
  if (typeof stored.experimentalGemini === 'boolean') {
    result.experimentalGemini = stored.experimentalGemini;
  }
  if (typeof stored.experimentalChat === 'boolean') {
    result.experimentalChat = stored.experimentalChat;
  }
  if (typeof stored.experimentalCanvas === 'boolean') {
    result.experimentalCanvas = stored.experimentalCanvas;
  }
  if (typeof stored.nativeBrowserView === 'boolean') {
    result.nativeBrowserView = stored.nativeBrowserView;
  }
  if (isClassAComposer(stored.classAComposer)) {
    result.classAComposer = stored.classAComposer;
  }
  if (typeof stored.inAppOrchestratorEnabled === 'boolean') {
    result.inAppOrchestratorEnabled = stored.inAppOrchestratorEnabled;
  }
  if (typeof stored.brainUseClaudeCli === 'boolean') {
    result.brainUseClaudeCli = stored.brainUseClaudeCli;
  }
  if (isWorkersUseBrain(stored.workersUseBrain)) {
    result.workersUseBrain = stored.workersUseBrain;
  }
  if (isOrchestratorBackendSetting(stored.orchestratorBackend)) {
    result.orchestratorBackend = stored.orchestratorBackend;
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
  const envRuntime = envDefaultDispatchRuntime();
  const envDispatchModel = envDefaultDispatchModel();
  const envLocalBaseUrl = envLocalInferenceBaseUrl();
  const envLocalEmbed = envLocalEmbedModel();
  const envLocalChat = envLocalChatModel();
  const envOpencode = envExperimentalOpencode();
  const envGemini = envExperimentalGemini();
  const envChat = envExperimentalChat();
  const envCanvas = envExperimentalCanvas();
  const envNative = envNativeBrowserView();
  const envComposer = envClassAComposer();
  const envInApp = envInAppOrchestratorEnabled();
  const envBrainCli = envBrainUseClaudeCli();
  const envBrain = envWorkersUseBrain();
  const envOrchBackend = envOrchestratorBackend();

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
    defaultDispatchRuntime: envRuntime ?? fileValues.defaultDispatchRuntime ?? OPERATOR_DEFAULTS_FALLBACK.defaultDispatchRuntime,
    defaultDispatchModel: envDispatchModel ?? fileValues.defaultDispatchModel ?? OPERATOR_DEFAULTS_FALLBACK.defaultDispatchModel,
    localInferenceBaseUrl: envLocalBaseUrl ?? fileValues.localInferenceBaseUrl ?? OPERATOR_DEFAULTS_FALLBACK.localInferenceBaseUrl,
    localEmbedModel: envLocalEmbed ?? fileValues.localEmbedModel ?? OPERATOR_DEFAULTS_FALLBACK.localEmbedModel,
    localChatModel: envLocalChat ?? fileValues.localChatModel ?? OPERATOR_DEFAULTS_FALLBACK.localChatModel,
    experimentalOpencode: envOpencode ?? fileValues.experimentalOpencode ?? OPERATOR_DEFAULTS_FALLBACK.experimentalOpencode,
    experimentalGemini: envGemini ?? fileValues.experimentalGemini ?? OPERATOR_DEFAULTS_FALLBACK.experimentalGemini,
    experimentalChat: envChat ?? fileValues.experimentalChat ?? OPERATOR_DEFAULTS_FALLBACK.experimentalChat,
    experimentalCanvas: envCanvas ?? fileValues.experimentalCanvas ?? OPERATOR_DEFAULTS_FALLBACK.experimentalCanvas,
    nativeBrowserView: envNative ?? fileValues.nativeBrowserView ?? OPERATOR_DEFAULTS_FALLBACK.nativeBrowserView,
    classAComposer: envComposer ?? fileValues.classAComposer ?? OPERATOR_DEFAULTS_FALLBACK.classAComposer,
    inAppOrchestratorEnabled:
      envInApp ?? fileValues.inAppOrchestratorEnabled ?? OPERATOR_DEFAULTS_FALLBACK.inAppOrchestratorEnabled,
    brainUseClaudeCli:
      envBrainCli ?? fileValues.brainUseClaudeCli ?? OPERATOR_DEFAULTS_FALLBACK.brainUseClaudeCli,
    workersUseBrain: envBrain ?? fileValues.workersUseBrain ?? OPERATOR_DEFAULTS_FALLBACK.workersUseBrain,
    orchestratorBackend: envOrchBackend ?? fileValues.orchestratorBackend ?? OPERATOR_DEFAULTS_FALLBACK.orchestratorBackend,
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
    defaultDispatchRuntime: envRuntime !== null ? 'env' : fileValues.defaultDispatchRuntime !== undefined ? 'file' : 'default',
    defaultDispatchModel: envDispatchModel !== null ? 'env' : fileValues.defaultDispatchModel !== undefined ? 'file' : 'default',
    localInferenceBaseUrl: envLocalBaseUrl !== null ? 'env' : fileValues.localInferenceBaseUrl !== undefined ? 'file' : 'default',
    localEmbedModel: envLocalEmbed !== null ? 'env' : fileValues.localEmbedModel !== undefined ? 'file' : 'default',
    localChatModel: envLocalChat !== null ? 'env' : fileValues.localChatModel !== undefined ? 'file' : 'default',
    experimentalOpencode: envOpencode !== null ? 'env' : fileValues.experimentalOpencode !== undefined ? 'file' : 'default',
    experimentalGemini: envGemini !== null ? 'env' : fileValues.experimentalGemini !== undefined ? 'file' : 'default',
    experimentalChat: envChat !== null ? 'env' : fileValues.experimentalChat !== undefined ? 'file' : 'default',
    experimentalCanvas: envCanvas !== null ? 'env' : fileValues.experimentalCanvas !== undefined ? 'file' : 'default',
    nativeBrowserView: envNative !== null ? 'env' : fileValues.nativeBrowserView !== undefined ? 'file' : 'default',
    classAComposer: envComposer !== null ? 'env' : fileValues.classAComposer !== undefined ? 'file' : 'default',
    inAppOrchestratorEnabled:
      envInApp !== null ? 'env' : fileValues.inAppOrchestratorEnabled !== undefined ? 'file' : 'default',
    brainUseClaudeCli:
      envBrainCli !== null ? 'env' : fileValues.brainUseClaudeCli !== undefined ? 'file' : 'default',
    workersUseBrain: envBrain !== null ? 'env' : fileValues.workersUseBrain !== undefined ? 'file' : 'default',
    orchestratorBackend: envOrchBackend !== null ? 'env' : fileValues.orchestratorBackend !== undefined ? 'file' : 'default',
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
  if (update.defaultDispatchRuntime !== undefined) {
    if (!isDispatchRuntime(update.defaultDispatchRuntime)) {
      throw new Error('defaultDispatchRuntime must be one of "codex", "claude-code", "gemini", "opencode".');
    }
    stored.defaultDispatchRuntime = update.defaultDispatchRuntime;
  }
  if (update.defaultDispatchModel !== undefined) {
    // Empty string clears it (back to the runtime default); any string is valid
    // (cloud name, or the `ollama:`/`lmstudio:` local convention).
    stored.defaultDispatchModel = update.defaultDispatchModel.trim();
  }
  if (update.localInferenceBaseUrl !== undefined) {
    if (typeof update.localInferenceBaseUrl !== 'string') {
      throw new Error('localInferenceBaseUrl must be a string.');
    }
    stored.localInferenceBaseUrl = update.localInferenceBaseUrl.trim();
  }
  if (update.localEmbedModel !== undefined) {
    if (typeof update.localEmbedModel !== 'string') {
      throw new Error('localEmbedModel must be a string.');
    }
    stored.localEmbedModel = update.localEmbedModel.trim();
  }
  if (update.localChatModel !== undefined) {
    if (typeof update.localChatModel !== 'string') {
      throw new Error('localChatModel must be a string.');
    }
    stored.localChatModel = update.localChatModel.trim();
  }
  if (update.experimentalOpencode !== undefined) {
    stored.experimentalOpencode = Boolean(update.experimentalOpencode);
  }
  if (update.experimentalGemini !== undefined) {
    stored.experimentalGemini = Boolean(update.experimentalGemini);
  }
  if (update.experimentalChat !== undefined) {
    stored.experimentalChat = Boolean(update.experimentalChat);
  }
  if (update.experimentalCanvas !== undefined) {
    stored.experimentalCanvas = Boolean(update.experimentalCanvas);
  }
  if (update.nativeBrowserView !== undefined) {
    stored.nativeBrowserView = Boolean(update.nativeBrowserView);
  }
  if (update.classAComposer !== undefined) {
    if (!isClassAComposer(update.classAComposer)) {
      throw new Error('classAComposer must be one of "auto", "haiku-cli", "sonnet-cli", "fastest".');
    }
    stored.classAComposer = update.classAComposer;
  }
  if (update.inAppOrchestratorEnabled !== undefined) {
    stored.inAppOrchestratorEnabled = Boolean(update.inAppOrchestratorEnabled);
  }
  if (update.brainUseClaudeCli !== undefined) {
    stored.brainUseClaudeCli = Boolean(update.brainUseClaudeCli);
  }
  if (update.workersUseBrain !== undefined) {
    if (!isWorkersUseBrain(update.workersUseBrain)) {
      throw new Error('workersUseBrain must be one of "off", "auto", "all".');
    }
    stored.workersUseBrain = update.workersUseBrain;
  }
  if (update.orchestratorBackend !== undefined) {
    if (!isOrchestratorBackendSetting(update.orchestratorBackend)) {
      throw new Error('orchestratorBackend must be one of "auto", "codex", "claude", "openclaw".');
    }
    stored.orchestratorBackend = update.orchestratorBackend;
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

export function resolveDefaultDispatchRuntimeSync(): OrchestratorRuntime {
  return getOperatorDefaultsSync().values.defaultDispatchRuntime;
}

/** Default worker model ('' = runtime's own default). Applied at the Codex
 *  launch chokepoint so every dispatched worker inherits it; per-mission model
 *  still wins. Set to `ollama:<model>` / `lmstudio:<model>` to dispatch local. */
export function resolveDefaultDispatchModelSync(): string {
  return getOperatorDefaultsSync().values.defaultDispatchModel;
}

/** Local inference endpoint base URL ('' = use cloud). Read by the Brain
 *  embeddings path to route to a local OpenAI-compatible server (Ollama /
 *  LM Studio). NO trailing /v1 — consumers append the path. */
export function resolveLocalInferenceBaseUrlSync(): string {
  return getOperatorDefaultsSync().values.localInferenceBaseUrl;
}

/** Local embedding model for the Brain ('' = no local embeddings). */
export function resolveLocalEmbedModelSync(): string {
  return getOperatorDefaultsSync().values.localEmbedModel;
}

/** Local chat model for Brain compose/classify + dictation polish ('' = cloud). */
export function resolveLocalChatModelSync(): string {
  return getOperatorDefaultsSync().values.localChatModel;
}

export function resolveExperimentalOpencodeSync(): boolean {
  return getOperatorDefaultsSync().values.experimentalOpencode;
}

export function resolveInAppOrchestratorEnabledSync(): boolean {
  return getOperatorDefaultsSync().values.inAppOrchestratorEnabled;
}

/**
 * Whether the Engineering Brain may use the Claude CLI warm pool (Haiku/Sonnet).
 * Decoupled from {@link resolveInAppOrchestratorEnabledSync} (2026-06-22) so a
 * Codex-orchestrator user still gets the fast sub-billed warm Brain.
 */
export function resolveBrainUseClaudeCliSync(): boolean {
  return getOperatorDefaultsSync().values.brainUseClaudeCli;
}

export function resolveWorkersUseBrainSync(): WorkersUseBrain {
  return getOperatorDefaultsSync().values.workersUseBrain;
}

/**
 * Which backend drives the in-app Orchestrator. 'auto' means "defer to
 * {@link resolveInAppOrchestratorEnabledSync}" — the registry's
 * `resolveOrchestratorBackendId` applies that fallback so 'auto' is byte-identical
 * to the pre-setting derivation.
 */
export function resolveOrchestratorBackendSync(): OrchestratorBackendSetting {
  return getOperatorDefaultsSync().values.orchestratorBackend;
}
