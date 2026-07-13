import 'server-only';

import { isThinkingEffort, type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import type { AutoApplyUpdates } from '@/lib/app-update/relaunch-state';
import { isSubscriptionProfile, type SubscriptionProfile } from './subscription-profile';

/**
 * Setting vocabularies + env-var overrides for {@link OperatorDefaults}
 * (extracted from defaults.ts when it outgrew the file ceiling — this module
 * holds the leaf types, their validators, and the `envXxx()` readers;
 * defaults.ts re-exports the public names so import sites are unchanged).
 */
export const DISPATCH_RUNTIMES: OrchestratorRuntime[] = ['codex', 'claude-code', 'opencode', 'cursor', 'grok', 'pi'];
export function isDispatchRuntime(value: unknown): value is OrchestratorRuntime {
  return typeof value === 'string' && (DISPATCH_RUNTIMES as string[]).includes(value);
}

export type OverlapGateMode = 'advisory' | 'strict';

/**
 * Q&A Class A composer routing (#971, 'fastest' added #1124-era perf pass).
 *   - `auto` / `haiku-cli` — current chain: Haiku CLI tier 1, then Codex/OpenRouter/Flash/Sonnet CLI fallbacks.
 *   - `sonnet-cli` — lead with Sonnet CLI for higher quality. Skips Haiku + Codex tiers.
 *   - `fastest` — lead with OpenRouter flash-lite (~1-3s, pennies, daily-capped), free tiers as fallback.
 * Eval-mode (smoke gate) is unaffected — always routes through OpenRouter Sonnet 4.6.
 */
export type ClassAComposer = 'auto' | 'haiku-cli' | 'sonnet-cli' | 'fastest';

export function isClassAComposer(value: unknown): value is ClassAComposer {
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

export function isWorkersUseBrain(value: unknown): value is WorkersUseBrain {
  return value === 'off' || value === 'auto' || value === 'all';
}

/** Which backend drives the in-app Orchestrator. 'auto' = the legacy
 *  inAppOrchestratorEnabled derivation; a specific id forces that backend. */
export type OrchestratorBackendSetting = 'auto' | 'codex' | 'claude' | 'openclaw' | 'hermes' | 'collide' | 'fable' | 'o8';

export function isOrchestratorBackendSetting(value: unknown): value is OrchestratorBackendSetting {
  return value === 'auto' || value === 'codex' || value === 'claude' || value === 'openclaw'
    || value === 'hermes' || value === 'collide' || value === 'fable' || value === 'o8';
}

/**
 * Which backend runs lane auto-reviews. 'follow' (default) rides the active
 * orchestrator backend — byte-identical to pre-setting behavior. Splitting the
 * roles lets the bulk orchestrator run on the Codex sub while reviews — short,
 * bounded, accuracy-critical — run on Claude (opposite-frontier pairing:
 * Codex writes, Claude reviews). Q ruling 2026-07-07. Env: `O8_REVIEWER_BACKEND`.
 */
export type ReviewerBackendSetting = 'follow' | 'codex' | 'claude';

export function isReviewerBackendSetting(value: unknown): value is ReviewerBackendSetting {
  return value === 'follow' || value === 'codex' || value === 'claude';
}

export type CollideAggregator = 'auto' | 'claude' | 'codex';

export function isCollideAggregator(value: unknown): value is CollideAggregator {
  return value === 'auto' || value === 'claude' || value === 'codex';
}

/**
 * Where a PR row opens (Git & PRs tab). 'in-app' (default) renders the embedded
 * PrPanel; 'browser' hands the github.com/.../pull URL to the OS browser.
 * Byte-identical to pre-setting behavior at the default. Env: `O8_PR_LINK_DESTINATION`.
 */
export type PrLinkDestination = 'in-app' | 'browser';

export function isPrLinkDestination(value: unknown): value is PrLinkDestination {
  return value === 'in-app' || value === 'browser';
}

/**
 * Clean a stored/typed branch prefix into a safe leading branch segment
 * (`[a-z0-9/_-]`, collapsed slashes/dashes, no leading/trailing separators).
 * Returns null when nothing usable remains — callers validate-or-null so a junk
 * value falls through to the current-behavior default rather than corrupting a
 * branch name.
 */
export function sanitizeBranchPrefix(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]/g, '-')
    .replace(/\/+/g, '/')
    .replace(/-+/g, '-')
    .replace(/^[-/.]+|[-/.]+$/g, '')
    .slice(0, 40);
  return cleaned || null;
}


// ── Env overrides ──

export function envParallelCap(): number | null {
  const raw = process.env.O8_MAX_PARALLEL_DISPATCHES;
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function envSubscriptionProfile(): SubscriptionProfile | null {
  const raw = process.env.O8_SUBSCRIPTION_PROFILE?.trim();
  if (raw && isSubscriptionProfile(raw)) return raw;
  return null;
}

export function envOverlapGate(): OverlapGateMode | null {
  const raw = process.env.O8_STRICT_OVERLAP_GATE;
  if (raw === '1') return 'strict';
  if (raw === '0') return 'advisory';
  return null;
}

export function envSupervisorAutoEscalate(): boolean | null {
  const raw = process.env.O8_SUPERVISOR_AUTO_ESCALATE;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

export function envHealBotEnabled(): boolean | null {
  const raw = process.env.O8_HEAL_BOT_ENABLED;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

export function envPromptCachingEnabled(): boolean | null {
  const raw = process.env.O8_PROMPT_CACHING;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

export function envThinkingEffort(): ThinkingEffort | null {
  const raw = process.env.O8_THINKING_EFFORT;
  if (raw && isThinkingEffort(raw)) return raw;
  return null;
}

export function envOrchestratorModel(): string | null {
  const raw = process.env.O8_ORCHESTRATOR_MODEL;
  return raw?.trim() || null;
}

export function envDefaultDispatchRuntime(): OrchestratorRuntime | null {
  const raw = process.env.O8_DEFAULT_DISPATCH_RUNTIME?.trim();
  if (!raw) return null;
  if (isDispatchRuntime(raw)) return raw;
  return null;
}

export function envCodexWorkerEffort(): ThinkingEffort | null {
  const raw = process.env.O8_CODEX_WORKER_EFFORT?.trim();
  if (raw && isThinkingEffort(raw)) return raw;
  return null;
}

export function envClaudeWorkerEffort(): ThinkingEffort | null {
  const raw = process.env.O8_CLAUDE_WORKER_EFFORT?.trim();
  if (raw && isThinkingEffort(raw)) return raw;
  return null;
}

export function envDefaultDispatchModel(): string | null {
  const raw = process.env.O8_DISPATCH_MODEL;
  return raw?.trim() || null;
}

export function envLocalInferenceBaseUrl(): string | null {
  return process.env.O8_LOCAL_INFERENCE_BASE_URL?.trim() || null;
}

export function envLocalEmbedModel(): string | null {
  return process.env.O8_LOCAL_EMBED_MODEL?.trim() || null;
}

export function envLocalChatModel(): string | null {
  return process.env.O8_LOCAL_CHAT_MODEL?.trim() || null;
}

export function envExperimentalOpencode(): boolean | null {
  const raw = process.env.O8_EXPERIMENTAL_OPENCODE;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

export function envExperimentalGemini(): boolean | null {
  const raw = process.env.O8_EXPERIMENTAL_GEMINI;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

export function envExperimentalChat(): boolean | null {
  const raw = process.env.O8_EXPERIMENTAL_CHAT;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

export function envExperimentalCanvas(): boolean | null {
  const raw = process.env.O8_EXPERIMENTAL_CANVAS;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

export function envNativeBrowserView(): boolean | null {
  const raw = process.env.O8_NATIVE_BROWSER_VIEW;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

export function envClassAComposer(): ClassAComposer | null {
  const raw = process.env.O8_CLASS_A_COMPOSER?.trim();
  if (raw && isClassAComposer(raw)) return raw;
  return null;
}

export function envInAppOrchestratorEnabled(): boolean | null {
  const raw = process.env.O8_IN_APP_ORCHESTRATOR_ENABLED;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

export function envBrainUseClaudeCli(): boolean | null {
  const raw = process.env.O8_BRAIN_USE_CLAUDE_CLI;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

export function envWorkersUseBrain(): WorkersUseBrain | null {
  const raw = process.env.O8_WORKERS_USE_BRAIN?.trim();
  if (raw && isWorkersUseBrain(raw)) return raw;
  return null;
}

export function envOrchestratorBackend(): OrchestratorBackendSetting | null {
  const raw = process.env.O8_ORCHESTRATOR_BACKEND?.trim();
  if (raw && isOrchestratorBackendSetting(raw)) return raw;
  return null;
}

export function envReviewerBackend(): ReviewerBackendSetting | null {
  const raw = process.env.O8_REVIEWER_BACKEND?.trim();
  if (raw && isReviewerBackendSetting(raw)) return raw;
  return null;
}

export function envPacketExplainerEnabled(): boolean | null {
  const raw = process.env.O8_EXPLAINER;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

export function envQuizGateEnabled(): boolean | null {
  const raw = process.env.O8_QUIZ_GATE;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

export function envBuyinDocEnabled(): boolean | null {
  const raw = process.env.O8_BUYIN_DOC;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

export function envCollideAggregator(): CollideAggregator | null {
  const raw = process.env.O8_COLLIDE_AGGREGATOR_DEFAULT?.trim();
  if (raw && isCollideAggregator(raw)) return raw;
  return null;
}

export function envAutoApplyUpdates(): AutoApplyUpdates | null {
  const raw = process.env.O8_AUTO_APPLY_UPDATES?.trim();
  if (raw === 'off' || raw === 'when-idle') return raw;
  return null;
}

export function envTelemetryOptIn(): boolean | null {
  const raw = process.env.O8_TELEMETRY_OPT_IN;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

export function envTelemetryIngestUrl(): string | null {
  return process.env.O8_TELEMETRY_INGEST_URL?.trim() || null;
}

export function envCrashReports(): boolean | null {
  const raw = process.env.O8_CRASH_REPORTS;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

export function envBranchPrefix(): string | null {
  return sanitizeBranchPrefix(process.env.O8_BRANCH_PREFIX);
}

export function envCommitAttribution(): boolean | null {
  const raw = process.env.O8_COMMIT_ATTRIBUTION;
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

export function envPrLinkDestination(): PrLinkDestination | null {
  const raw = process.env.O8_PR_LINK_DESTINATION?.trim();
  if (raw && isPrLinkDestination(raw)) return raw;
  return null;
}
