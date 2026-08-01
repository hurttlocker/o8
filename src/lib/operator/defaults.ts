import 'server-only';

import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MODEL_IDS } from '@/lib/models';

import { isThinkingEffort, type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import type { UpdateAutoApply } from '@/lib/app-update/types';
import {
  resolveDefaultDispatchRuntime as resolvePairedDefaultDispatchRuntime,
} from './dispatch-runtime-default';
import {
  isSubscriptionProfile,
  resolveSubscriptionProfileHouseDefaults,
  type SubscriptionProfile,
} from './subscription-profile';
import { resolveWorkerEffortDefault } from './worker-effort-default';
import {
  coerceStoredTier,
  envTargetingTier,
  isTargetingTier,
  mergeTier,
  type TargetingTier,
} from './targeting-tier';

export { isSubscriptionProfile };

import { isOrchestratorBackendSetting, isReviewerBackendSetting, isCollideAggregator, isPrLinkDestination, sanitizeBranchPrefix, type OrchestratorBackendSetting, type ReviewerBackendSetting, type CollideAggregator, type PrLinkDestination } from './defaults-env';
import {
  isDispatchRuntime,
  isClassAComposer,
  isWorkersUseBrain,
  envUpdateAutoApply,
  envBranchPrefix,
  envCommitAttribution,
  envPrLinkDestination,
  envBrainUseClaudeCli,
  envBuyinDocEnabled,
  envClassAComposer,
  envClaudeWorkerEffort,
  envCodexWorkerEffort,
  envCollideAggregator,
  envDefaultDispatchModel,
  envDefaultDispatchRuntime,
  envExperimentalCanvas,
  envExperimentalChat,
  envExperimentalGemini,
  envExperimentalOpencode,
  envHealBotEnabled,
  envInAppOrchestratorEnabled,
  envLocalChatModel,
  envLocalEmbedModel,
  envLocalInferenceBaseUrl,
  envNativeBrowserView,
  envOrchestratorBackend,
  envOrchestratorModel,
  envOverlapGate,
  envPacketExplainerEnabled,
  envParallelCap,
  envPromptCachingEnabled,
  envQuizGateEnabled,
  envReviewerBackend,
  envSubscriptionProfile,
  envCrashReports,
  envSupervisorAutoEscalate,
  envTelemetryIngestUrl,
  envTelemetryOptIn,
  envThinkingEffort,
  envWorkersUseBrain,
  envWorktreeMaxCount,
  envWorktreeMaxTotalGb,
  type OverlapGateMode,
  type ClassAComposer,
  type WorkersUseBrain,
} from './defaults-env';
import { getDataDir } from '@/lib/data-dir-migration';

export { isOrchestratorBackendSetting, isReviewerBackendSetting, isCollideAggregator, isPrLinkDestination } from './defaults-env';
export type {
  OverlapGateMode,
  ClassAComposer,
  WorkersUseBrain,
  OrchestratorBackendSetting,
  ReviewerBackendSetting,
  CollideAggregator,
  PrLinkDestination,
} from './defaults-env';
export { coerceStoredTier, isTargetingTier, mergeTier } from './targeting-tier';
export type { TargetingTier } from './targeting-tier';
export {
  CLASS_A_COMPOSER_OPTIONS,
  DISPATCH_RUNTIME_OPTIONS,
  ORCHESTRATOR_BACKEND_OPTIONS,
  ORCHESTRATOR_MODEL_OPTIONS,
  PARALLEL_CAP_PRESETS,
} from './default-options';
/**
 * Operator defaults — the dispatch/supervision knobs exposed in Settings
 * (one field per knob in {@link OperatorDefaults}; the count grows, don't
 * hardcode it in docs).
 *
 * Resolution order (every knob): env var > persisted file > hardcoded fallback.
 *
 * Persisted file: `~/.o8/operator-defaults.json`
 * (override root with CORTEX_IDE_DATA_DIR). NOTE: `~/.cortex-ide/` is NOT
 * read — a stale copy of this file there silently does nothing (bit the
 * operator flow 2026-07-07; always verify against getOperatorDefaultsPath()).
 */

export type SettingSource = 'env' | 'file' | 'default';

export type RequireApproval = 'high-risk' | 'surface' | 'always' | 'never';

export function isRequireApproval(value: unknown): value is RequireApproval {
  return value === 'high-risk' || value === 'surface' || value === 'always' || value === 'never';
}

export interface OperatorDefaults {
  subscriptionProfile: SubscriptionProfile;
  parallelCap: number;
  overlapGate: OverlapGateMode;
  healBotEnabled: boolean;
  supervisorAutoEscalate: boolean;
  /**
   * #1481 — when a mission lane reaches review-ready, queue a bounded
   * self-continuation turn on the orchestrator ("review + merge per the
   * standing instruction") instead of parking until the operator re-prompts.
   * Distinct from supervisorAutoEscalate (noisy failure investigations,
   * default off): this is the core review loop, default on.
   */
  reviewContinuation: boolean;
  thinkingEffort: ThinkingEffort;
  promptCachingEnabled: boolean;
  /** Opt-in: replay the repo's test command against a rebased branch in the
   *  merge gate (in addition to typecheck). Default off — tests can be slow. */
  mergeTestReplayEnabled: boolean;
  /** Human approval posture for lane merges. Hard governance gates still apply. */
  requireApproval: RequireApproval;
  orchestratorModel: string;
  defaultDispatchRuntime: OrchestratorRuntime;
  workerRuntimes: OrchestratorRuntime[];
  /** Default Codex worker effort. 'adaptive' preserves runtime default behavior. */
  codexWorkerEffort: ThinkingEffort;
  /** Default Claude Code worker effort. 'adaptive' preserves runtime default behavior. */
  claudeWorkerEffort: ThinkingEffort;
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
  experimentalOpencode: boolean;
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
   * a spatial canvas. Flag ON surfaces a Canvas
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
  /** Automatically redispatch a quota-capped packet worker on its equal-tier
   *  runtime from the other subscription house. Off preserves operator choice
   *  and raises an Incident Queue card instead. */
  crossHouseWorkerFallback: boolean;
  /**
   * Which backend drives the in-app Orchestrator. **'auto' (default)** = the
   * legacy derivation from {@link inAppOrchestratorEnabled} (toggle ON → Claude,
   * OFF → Codex), byte-identical to pre-setting behavior. A specific value forces
   * that backend — including **'openclaw'** (the governed openclaw orchestrator,
   * previously reachable only via a per-request mobile `backend` field). A
   * per-request `msg.backend` still overrides this. Env: `O8_ORCHESTRATOR_BACKEND`.
   */
  orchestratorBackend: OrchestratorBackendSetting;
  /** Which backend runs lane auto-reviews. 'follow' rides orchestratorBackend. */
  reviewerBackend: ReviewerBackendSetting;
  /**
   * HTML packet explainer generation (#1491). **On by default** — when a packet
   * reaches review, a self-contained explainer + quiz is generated
   * fire-and-forget and stored as a report artifact. Non-blocking; failure
   * degrades the review surface to the raw diff. Env: `O8_EXPLAINER`.
   */
  packetExplainerEnabled: boolean;
  /**
   * Quiz-gated human merge (#1491). **Off by default.** When on AND the packet
   * exceeds the changed-file threshold, the human Merge button is blocked until
   * the explainer quiz is passed. Human-UI only — the MCP/orchestrator approve
   * path stays ungated. Env: `O8_QUIZ_GATE`.
   */
  quizGateEnabled: boolean;
  /**
   * Auto buy-in doc on merge (#1492). **Off by default.** When on, a successful
   * packet merge generates a single self-contained, shareable HTML "buy-in doc"
   * (demo-first, plain-language what/why, deviations, verification, objections
   * pre-answered) fire-and-forget and stores it as a report artifact. Non-
   * blocking; a generation failure never touches the merge. Env: `O8_BUYIN_DOC`.
   */
  buyinDocEnabled: boolean;
  /** Targeting Machine — the cheap triage/rationale tier (default low effort). */
  targetingTriage: TargetingTier;
  /** Targeting Machine — the premium "point a real agent here" tier (default high). */
  targetingAction: TargetingTier;
  /** Auto-apply downloaded desktop updates only under conservative idle gates. */
  updateAutoApply: UpdateAutoApply;
  /** Collide aggregator override. Auto follows the active composer backend. */
  collideAggregator: CollideAggregator;
  /** Coarse product-usage telemetry. Explicit opt-in, persisted, and default off. */
  productTelemetryEnabled: boolean;
  /** Crash-log upload opt-in; local capture continues while off. Env: `O8_TELEMETRY_OPT_IN`. */
  telemetryOptIn: boolean;
  /** Crash-log endpoint, consulted only when telemetryOptIn is on. */
  telemetryIngestUrl: string;
  /** Scrubbed Sentry crash/error sharing, packaged builds only and default off. */
  crashReportsEnabled: boolean;
  /**
   * Prefix for branches o8 opens from GitHub issues (`<prefix>/<n>-<slug>`).
   * **Default `'issue'`** — byte-identical to the previous hardcoded literal.
   * Consumed at the single mission branch-target chokepoint
   * (`branchTargetForIssue`). Inline drafts keep their own `inline/` marker.
   * Env: `O8_BRANCH_PREFIX`.
   */
  branchPrefix: string;
  /**
   * Tag commits o8's agents create with a `Co-Authored-By` trailer. **Off by
   * default** — the agent worktree commit carries whatever message the caller
   * supplied, exactly as before. On appends the trailer at the single agent
   * commit site (`commitDirtyWorktree`). Env: `O8_COMMIT_ATTRIBUTION` (1/0).
   */
  commitAttributionEnabled: boolean;
  /**
   * Where clicking a PR row opens it. **Default `'in-app'`** — the embedded
   * PrPanel, unchanged. `'browser'` hands the github.com/.../pull URL to the OS
   * browser instead. Env: `O8_PR_LINK_DESTINATION`.
   */
  prLinkDestination: PrLinkDestination;
  /**
   * Retention ceiling for `.cortex-worktrees` packet worktrees — the max number
   * of SAFE (terminal-lane or orphan, clean git status) worktrees kept per repo
   * before the existing prune sweep reclaims the oldest first. **Default 20.**
   * Enforced only at the prune seam; never deletes an active/reviewing lane's
   * tree or one with uncommitted changes. `0` = unbounded (guard off). Env:
   * `O8_WORKTREE_MAX_COUNT`.
   */
  worktreeMaxCount: number;
  /**
   * Retention ceiling on the total on-disk size (GB) of safe `.cortex-worktrees`
   * worktrees per repo. **Default 20.** Beyond this, the prune sweep removes the
   * oldest safe+clean worktrees until the measured total drops under the cap.
   * `0` = unbounded (guard off). Env: `O8_WORKTREE_MAX_TOTAL_GB`.
   */
  worktreeMaxTotalGb: number;
}

export interface OperatorDefaultsWithSources {
  values: OperatorDefaults;
  sources: Record<keyof OperatorDefaults, SettingSource>;
}

// ── Hardcoded fallbacks (the "locked defaults") ──

export const OPERATOR_DEFAULTS_FALLBACK: OperatorDefaults = {
  subscriptionProfile: 'both',
  parallelCap: 5,
  overlapGate: 'advisory',
  healBotEnabled: true,
  supervisorAutoEscalate: false,
  reviewContinuation: true,
  // Operator-pinned: Opus 4.8 with max thinking is the default orchestrator
  // brain. Subscription-billed via the REPL migration, so cost is the user's
  // existing Claude Code MAX plan — not a per-token API charge.
  thinkingEffort: 'max',
  promptCachingEnabled: true,
  mergeTestReplayEnabled: false,
  requireApproval: 'high-risk',
  orchestratorModel: MODEL_IDS.orchestratorDefault,
  defaultDispatchRuntime: 'codex',
  workerRuntimes: ['codex'],
  codexWorkerEffort: 'adaptive',
  claudeWorkerEffort: 'adaptive',
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
  crossHouseWorkerFallback: false,
  // 'auto' → defer to inAppOrchestratorEnabled (legacy claude/codex derivation),
  // so the default is byte-identical to pre-setting behavior.
  orchestratorBackend: 'auto',
  // 'follow' → reviews ride the orchestrator backend (pre-split behavior).
  reviewerBackend: 'follow',
  // Explainer generation ON (non-blocking); quiz gate OFF (opt-in speed bump).
  packetExplainerEnabled: true,
  quizGateEnabled: false,
  // Buy-in doc generation OFF by default — opt-in narrative for external sharing.
  buyinDocEnabled: false,
  // Targeting Machine tiers. Both default to Codex (the shipping dispatch worker),
  // differentiated by effort — cheap triage at low, premium action at high. The
  // operator can point triage at a cheaper runtime/model (gemini, a local model).
  targetingTriage: { runtime: 'codex', model: '', effort: 'low' },
  targetingAction: { runtime: 'codex', model: '', effort: 'high' },
  updateAutoApply: 'off',
  collideAggregator: 'auto',
  productTelemetryEnabled: false,
  // Crash telemetry OFF by default — local capture only, nothing uploaded.
  telemetryOptIn: false,
  telemetryIngestUrl: '',
  // Sentry crash/error reports OFF by default. Operators must affirmatively
  // enable transmission even when a packaged build has a DSN.
  crashReportsEnabled: false,
  // Byte-identical to the previous hardcoded `issue/` branch literal.
  branchPrefix: 'issue',
  // Agent commit attribution OFF — commits carry the raw message as before.
  commitAttributionEnabled: false,
  // PR rows open the embedded PrPanel, as before.
  prLinkDestination: 'in-app',
  // Generous defaults — the guard only ever removes SAFE (terminal/orphan +
  // clean) worktrees oldest-first, so a fresh install behaves as before until a
  // repo genuinely accumulates >20 stale packet worktrees or >20GB of them.
  worktreeMaxCount: 20,
  worktreeMaxTotalGb: 20,
};

const OPERATOR_DEFAULTS_FILE = 'operator-defaults.json';

function getOperatorDefaultsPath() {
  return path.join(
    getDataDir(),
    OPERATOR_DEFAULTS_FILE,
  );
}

// ── File helpers ──

interface StoredOperatorDefaults {
  subscriptionProfile?: SubscriptionProfile;
  parallelCap?: number;
  overlapGate?: OverlapGateMode;
  healBotEnabled?: boolean;
  supervisorAutoEscalate?: boolean;
  reviewContinuation?: boolean;
  thinkingEffort?: ThinkingEffort;
  promptCachingEnabled?: boolean;
  mergeTestReplayEnabled?: boolean;
  requireApproval?: RequireApproval;
  orchestratorModel?: string;
  defaultDispatchRuntime?: OrchestratorRuntime;
  defaultDispatchRuntimeExplicit?: boolean;
  workerRuntimes?: OrchestratorRuntime[];
  codexWorkerEffort?: ThinkingEffort;
  claudeWorkerEffort?: ThinkingEffort;
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
  crossHouseWorkerFallback?: boolean;
  orchestratorBackend?: OrchestratorBackendSetting;
  reviewerBackend?: ReviewerBackendSetting;
  packetExplainerEnabled?: boolean;
  quizGateEnabled?: boolean;
  buyinDocEnabled?: boolean;
  targetingTriage?: TargetingTier;
  targetingAction?: TargetingTier;
  updateAutoApply?: UpdateAutoApply;
  autoApplyUpdates?: 'off' | 'when-idle';
  collideAggregator?: CollideAggregator;
  productTelemetryEnabled?: boolean;
  telemetryOptIn?: boolean;
  telemetryIngestUrl?: string;
  crashReportsEnabled?: boolean;
  branchPrefix?: string;
  commitAttributionEnabled?: boolean;
  prLinkDestination?: PrLinkDestination;
  worktreeMaxCount?: number;
  worktreeMaxTotalGb?: number;
}

type FileOperatorDefaults = Partial<OperatorDefaults> & {
  defaultDispatchRuntimeExplicit?: boolean;
};

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

function resolveFromFile(stored: StoredOperatorDefaults): FileOperatorDefaults {
  const result: FileOperatorDefaults = {};
  if (isSubscriptionProfile(stored.subscriptionProfile)) {
    result.subscriptionProfile = stored.subscriptionProfile;
  }
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
  if (typeof stored.reviewContinuation === 'boolean') {
    result.reviewContinuation = stored.reviewContinuation;
  }
  if (stored.thinkingEffort && isThinkingEffort(stored.thinkingEffort)) {
    result.thinkingEffort = stored.thinkingEffort;
  }
  if (typeof stored.promptCachingEnabled === 'boolean') {
    result.promptCachingEnabled = stored.promptCachingEnabled;
  }
  if (typeof stored.mergeTestReplayEnabled === 'boolean') {
    result.mergeTestReplayEnabled = stored.mergeTestReplayEnabled;
  }
  if (isRequireApproval(stored.requireApproval)) {
    result.requireApproval = stored.requireApproval;
  }
  if (typeof stored.orchestratorModel === 'string' && stored.orchestratorModel.trim()) {
    result.orchestratorModel = stored.orchestratorModel.trim();
  }
  if (isDispatchRuntime(stored.defaultDispatchRuntime)) {
    result.defaultDispatchRuntime = stored.defaultDispatchRuntime;
    result.defaultDispatchRuntimeExplicit = stored.defaultDispatchRuntimeExplicit !== false;
  }
  if (Array.isArray(stored.workerRuntimes)) {
    const workerRuntimes = [...new Set(stored.workerRuntimes.filter(isDispatchRuntime))];
    if (workerRuntimes.length > 0) result.workerRuntimes = workerRuntimes;
  }
  if (stored.codexWorkerEffort && isThinkingEffort(stored.codexWorkerEffort)) {
    result.codexWorkerEffort = stored.codexWorkerEffort;
  }
  if (stored.claudeWorkerEffort && isThinkingEffort(stored.claudeWorkerEffort)) {
    result.claudeWorkerEffort = stored.claudeWorkerEffort;
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
  if (typeof stored.crossHouseWorkerFallback === 'boolean') {
    result.crossHouseWorkerFallback = stored.crossHouseWorkerFallback;
  }
  if (isOrchestratorBackendSetting(stored.orchestratorBackend)) {
    result.orchestratorBackend = stored.orchestratorBackend;
  }
  if (isReviewerBackendSetting(stored.reviewerBackend)) {
    result.reviewerBackend = stored.reviewerBackend;
  }
  if (typeof stored.packetExplainerEnabled === 'boolean') {
    result.packetExplainerEnabled = stored.packetExplainerEnabled;
  }
  if (typeof stored.quizGateEnabled === 'boolean') {
    result.quizGateEnabled = stored.quizGateEnabled;
  }
  if (typeof stored.buyinDocEnabled === 'boolean') {
    result.buyinDocEnabled = stored.buyinDocEnabled;
  }
  const storedUpdateAutoApply = stored.updateAutoApply ?? (stored.autoApplyUpdates === 'when-idle' ? 'idle' : stored.autoApplyUpdates);
  if (storedUpdateAutoApply === 'off' || storedUpdateAutoApply === 'idle') result.updateAutoApply = storedUpdateAutoApply;
  if (isCollideAggregator(stored.collideAggregator)) {
    result.collideAggregator = stored.collideAggregator;
  }
  if (typeof stored.productTelemetryEnabled === 'boolean') result.productTelemetryEnabled = stored.productTelemetryEnabled;
  if (typeof stored.telemetryOptIn === 'boolean') {
    result.telemetryOptIn = stored.telemetryOptIn;
  }
  if (typeof stored.telemetryIngestUrl === 'string') {
    result.telemetryIngestUrl = stored.telemetryIngestUrl.trim();
  }
  if (typeof stored.crashReportsEnabled === 'boolean') {
    result.crashReportsEnabled = stored.crashReportsEnabled;
  }
  const cleanedBranchPrefix = sanitizeBranchPrefix(stored.branchPrefix);
  if (cleanedBranchPrefix) {
    result.branchPrefix = cleanedBranchPrefix;
  }
  if (typeof stored.commitAttributionEnabled === 'boolean') {
    result.commitAttributionEnabled = stored.commitAttributionEnabled;
  }
  if (isPrLinkDestination(stored.prLinkDestination)) {
    result.prLinkDestination = stored.prLinkDestination;
  }
  // Retention limits: accept any finite >= 0 (0 = unbounded/off). Junk falls
  // through to the fallback rather than corrupting the guard.
  if (typeof stored.worktreeMaxCount === 'number' && Number.isFinite(stored.worktreeMaxCount) && stored.worktreeMaxCount >= 0) {
    result.worktreeMaxCount = Math.floor(stored.worktreeMaxCount);
  }
  if (typeof stored.worktreeMaxTotalGb === 'number' && Number.isFinite(stored.worktreeMaxTotalGb) && stored.worktreeMaxTotalGb >= 0) {
    result.worktreeMaxTotalGb = stored.worktreeMaxTotalGb;
  }
  const storedTriage = coerceStoredTier(stored.targetingTriage, OPERATOR_DEFAULTS_FALLBACK.targetingTriage);
  if (storedTriage) result.targetingTriage = storedTriage;
  const storedAction = coerceStoredTier(stored.targetingAction, OPERATOR_DEFAULTS_FALLBACK.targetingAction);
  if (storedAction) result.targetingAction = storedAction;
  return result;
}

// ── Resolution ──

function resolveDefaults(fileValues: FileOperatorDefaults): OperatorDefaultsWithSources {
  const envProfile = envSubscriptionProfile();
  const envCap = envParallelCap();
  const envGate = envOverlapGate();
  const envHeal = envHealBotEnabled();
  const envEsc = envSupervisorAutoEscalate();
  const envThink = envThinkingEffort();
  const envCache = envPromptCachingEnabled();
  const envModel = envOrchestratorModel();
  const envRuntime = envDefaultDispatchRuntime();
  const envCodexEffort = envCodexWorkerEffort();
  const envClaudeEffort = envClaudeWorkerEffort();
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
  const envRevBackend = envReviewerBackend();
  const envExplainer = envPacketExplainerEnabled();
  const envQuizGate = envQuizGateEnabled();
  const envBuyinDoc = envBuyinDocEnabled();
  const envApplyUpdates = envUpdateAutoApply();
  const envCollideAgg = envCollideAggregator();
  const envTelemetry = envTelemetryOptIn();
  const envTelemetryUrl = envTelemetryIngestUrl();
  const envCrash = envCrashReports();
  const envBranch = envBranchPrefix();
  const envCommitAttrib = envCommitAttribution();
  const envPrLink = envPrLinkDestination();
  const envWtCount = envWorktreeMaxCount();
  const envWtSize = envWorktreeMaxTotalGb();
  const envTriage = envTargetingTier('TRIAGE');
  const envAction = envTargetingTier('ACTION');
  const subscriptionProfile =
    envProfile ?? fileValues.subscriptionProfile ?? OPERATOR_DEFAULTS_FALLBACK.subscriptionProfile;
  const profileDefaults = resolveSubscriptionProfileHouseDefaults(subscriptionProfile);
  const inAppOrchestratorEnabled =
    envInApp ?? fileValues.inAppOrchestratorEnabled ?? OPERATOR_DEFAULTS_FALLBACK.inAppOrchestratorEnabled;
  const baseOrchestratorBackend =
    envOrchBackend ?? fileValues.orchestratorBackend ?? OPERATOR_DEFAULTS_FALLBACK.orchestratorBackend;
  const orchestratorBackend = profileDefaults?.orchestratorBackend ?? baseOrchestratorBackend;
  const baseDefaultDispatchRuntime = resolvePairedDefaultDispatchRuntime({
    explicitRuntime: envRuntime ?? (fileValues.defaultDispatchRuntimeExplicit ? fileValues.defaultDispatchRuntime : null),
    orchestratorBackend: baseOrchestratorBackend,
    inAppOrchestratorEnabled,
  });
  const defaultDispatchRuntime = profileDefaults?.defaultDispatchRuntime ?? baseDefaultDispatchRuntime;

  const resolved: OperatorDefaults = {
    subscriptionProfile,
    parallelCap: envCap ?? fileValues.parallelCap ?? OPERATOR_DEFAULTS_FALLBACK.parallelCap,
    overlapGate: envGate ?? fileValues.overlapGate ?? OPERATOR_DEFAULTS_FALLBACK.overlapGate,
    healBotEnabled: envHeal ?? fileValues.healBotEnabled ?? OPERATOR_DEFAULTS_FALLBACK.healBotEnabled,
    supervisorAutoEscalate:
      envEsc ?? fileValues.supervisorAutoEscalate ?? OPERATOR_DEFAULTS_FALLBACK.supervisorAutoEscalate,
    reviewContinuation:
      fileValues.reviewContinuation ?? OPERATOR_DEFAULTS_FALLBACK.reviewContinuation,
    thinkingEffort: envThink ?? fileValues.thinkingEffort ?? OPERATOR_DEFAULTS_FALLBACK.thinkingEffort,
    promptCachingEnabled:
      envCache ?? fileValues.promptCachingEnabled ?? OPERATOR_DEFAULTS_FALLBACK.promptCachingEnabled,
    mergeTestReplayEnabled:
      fileValues.mergeTestReplayEnabled ?? OPERATOR_DEFAULTS_FALLBACK.mergeTestReplayEnabled,
    requireApproval: fileValues.requireApproval ?? OPERATOR_DEFAULTS_FALLBACK.requireApproval,
    orchestratorModel: envModel ?? fileValues.orchestratorModel ?? OPERATOR_DEFAULTS_FALLBACK.orchestratorModel,
    defaultDispatchRuntime,
    workerRuntimes: fileValues.workerRuntimes ?? OPERATOR_DEFAULTS_FALLBACK.workerRuntimes,
    codexWorkerEffort:
      envCodexEffort ?? fileValues.codexWorkerEffort ?? OPERATOR_DEFAULTS_FALLBACK.codexWorkerEffort,
    claudeWorkerEffort:
      envClaudeEffort ?? fileValues.claudeWorkerEffort ?? OPERATOR_DEFAULTS_FALLBACK.claudeWorkerEffort,
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
    inAppOrchestratorEnabled,
    brainUseClaudeCli:
      envBrainCli ?? fileValues.brainUseClaudeCli ?? OPERATOR_DEFAULTS_FALLBACK.brainUseClaudeCli,
    workersUseBrain: envBrain ?? fileValues.workersUseBrain ?? OPERATOR_DEFAULTS_FALLBACK.workersUseBrain,
    crossHouseWorkerFallback:
      fileValues.crossHouseWorkerFallback ?? OPERATOR_DEFAULTS_FALLBACK.crossHouseWorkerFallback,
    orchestratorBackend,
    reviewerBackend: profileDefaults?.reviewerBackend
      ?? envRevBackend
      ?? fileValues.reviewerBackend
      ?? OPERATOR_DEFAULTS_FALLBACK.reviewerBackend,
    packetExplainerEnabled: envExplainer ?? fileValues.packetExplainerEnabled ?? OPERATOR_DEFAULTS_FALLBACK.packetExplainerEnabled,
    quizGateEnabled: envQuizGate ?? fileValues.quizGateEnabled ?? OPERATOR_DEFAULTS_FALLBACK.quizGateEnabled,
    buyinDocEnabled: envBuyinDoc ?? fileValues.buyinDocEnabled ?? OPERATOR_DEFAULTS_FALLBACK.buyinDocEnabled,
    targetingTriage: mergeTier(envTriage, fileValues.targetingTriage, OPERATOR_DEFAULTS_FALLBACK.targetingTriage),
    targetingAction: mergeTier(envAction, fileValues.targetingAction, OPERATOR_DEFAULTS_FALLBACK.targetingAction),
    updateAutoApply: envApplyUpdates ?? fileValues.updateAutoApply ?? OPERATOR_DEFAULTS_FALLBACK.updateAutoApply,
    collideAggregator: envCollideAgg ?? fileValues.collideAggregator ?? OPERATOR_DEFAULTS_FALLBACK.collideAggregator,
    productTelemetryEnabled: fileValues.productTelemetryEnabled ?? OPERATOR_DEFAULTS_FALLBACK.productTelemetryEnabled,
    telemetryOptIn: envTelemetry ?? fileValues.telemetryOptIn ?? OPERATOR_DEFAULTS_FALLBACK.telemetryOptIn,
    telemetryIngestUrl: envTelemetryUrl ?? fileValues.telemetryIngestUrl ?? OPERATOR_DEFAULTS_FALLBACK.telemetryIngestUrl,
    crashReportsEnabled: envCrash ?? fileValues.crashReportsEnabled ?? OPERATOR_DEFAULTS_FALLBACK.crashReportsEnabled,
    branchPrefix: envBranch ?? fileValues.branchPrefix ?? OPERATOR_DEFAULTS_FALLBACK.branchPrefix,
    commitAttributionEnabled: envCommitAttrib ?? fileValues.commitAttributionEnabled ?? OPERATOR_DEFAULTS_FALLBACK.commitAttributionEnabled,
    prLinkDestination: envPrLink ?? fileValues.prLinkDestination ?? OPERATOR_DEFAULTS_FALLBACK.prLinkDestination,
    worktreeMaxCount: envWtCount ?? fileValues.worktreeMaxCount ?? OPERATOR_DEFAULTS_FALLBACK.worktreeMaxCount,
    worktreeMaxTotalGb: envWtSize ?? fileValues.worktreeMaxTotalGb ?? OPERATOR_DEFAULTS_FALLBACK.worktreeMaxTotalGb,
  };

  const sources: Record<keyof OperatorDefaults, SettingSource> = {
    subscriptionProfile: envProfile !== null ? 'env' : fileValues.subscriptionProfile !== undefined ? 'file' : 'default',
    parallelCap: envCap !== null ? 'env' : fileValues.parallelCap !== undefined ? 'file' : 'default',
    overlapGate: envGate !== null ? 'env' : fileValues.overlapGate !== undefined ? 'file' : 'default',
    healBotEnabled: envHeal !== null ? 'env' : fileValues.healBotEnabled !== undefined ? 'file' : 'default',
    supervisorAutoEscalate:
      envEsc !== null ? 'env' : fileValues.supervisorAutoEscalate !== undefined ? 'file' : 'default',
    reviewContinuation: fileValues.reviewContinuation !== undefined ? 'file' : 'default',
    thinkingEffort: envThink !== null ? 'env' : fileValues.thinkingEffort !== undefined ? 'file' : 'default',
    promptCachingEnabled:
      envCache !== null ? 'env' : fileValues.promptCachingEnabled !== undefined ? 'file' : 'default',
    mergeTestReplayEnabled: fileValues.mergeTestReplayEnabled !== undefined ? 'file' : 'default',
    requireApproval: fileValues.requireApproval !== undefined ? 'file' : 'default',
    orchestratorModel: envModel !== null ? 'env' : fileValues.orchestratorModel !== undefined ? 'file' : 'default',
    defaultDispatchRuntime: envRuntime !== null ? 'env' : fileValues.defaultDispatchRuntimeExplicit ? 'file' : 'default',
    workerRuntimes: fileValues.workerRuntimes !== undefined ? 'file' : 'default',
    codexWorkerEffort:
      envCodexEffort !== null ? 'env' : fileValues.codexWorkerEffort !== undefined ? 'file' : 'default',
    claudeWorkerEffort:
      envClaudeEffort !== null ? 'env' : fileValues.claudeWorkerEffort !== undefined ? 'file' : 'default',
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
    crossHouseWorkerFallback: fileValues.crossHouseWorkerFallback !== undefined ? 'file' : 'default',
    orchestratorBackend: envOrchBackend !== null ? 'env' : fileValues.orchestratorBackend !== undefined ? 'file' : 'default',
    reviewerBackend: envRevBackend !== null ? 'env' : fileValues.reviewerBackend !== undefined ? 'file' : 'default',
    packetExplainerEnabled: envExplainer !== null ? 'env' : fileValues.packetExplainerEnabled !== undefined ? 'file' : 'default',
    quizGateEnabled: envQuizGate !== null ? 'env' : fileValues.quizGateEnabled !== undefined ? 'file' : 'default',
    buyinDocEnabled: envBuyinDoc !== null ? 'env' : fileValues.buyinDocEnabled !== undefined ? 'file' : 'default',
    targetingTriage: envTriage !== null ? 'env' : fileValues.targetingTriage !== undefined ? 'file' : 'default',
    targetingAction: envAction !== null ? 'env' : fileValues.targetingAction !== undefined ? 'file' : 'default',
    updateAutoApply: envApplyUpdates !== null ? 'env' : fileValues.updateAutoApply !== undefined ? 'file' : 'default',
    collideAggregator: envCollideAgg !== null ? 'env' : fileValues.collideAggregator !== undefined ? 'file' : 'default',
    productTelemetryEnabled: fileValues.productTelemetryEnabled !== undefined ? 'file' : 'default',
    telemetryOptIn: envTelemetry !== null ? 'env' : fileValues.telemetryOptIn !== undefined ? 'file' : 'default',
    telemetryIngestUrl: envTelemetryUrl !== null ? 'env' : fileValues.telemetryIngestUrl !== undefined ? 'file' : 'default',
    crashReportsEnabled: envCrash !== null ? 'env' : fileValues.crashReportsEnabled !== undefined ? 'file' : 'default',
    branchPrefix: envBranch !== null ? 'env' : fileValues.branchPrefix !== undefined ? 'file' : 'default',
    commitAttributionEnabled: envCommitAttrib !== null ? 'env' : fileValues.commitAttributionEnabled !== undefined ? 'file' : 'default',
    prLinkDestination: envPrLink !== null ? 'env' : fileValues.prLinkDestination !== undefined ? 'file' : 'default',
    worktreeMaxCount: envWtCount !== null ? 'env' : fileValues.worktreeMaxCount !== undefined ? 'file' : 'default',
    worktreeMaxTotalGb: envWtSize !== null ? 'env' : fileValues.worktreeMaxTotalGb !== undefined ? 'file' : 'default',
  };

  return { values: resolved, sources };
}

export async function getOperatorDefaults(): Promise<OperatorDefaultsWithSources> {
  let fileValues: FileOperatorDefaults = {};
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
  let fileValues: FileOperatorDefaults = {};
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
  if (update.subscriptionProfile !== undefined) {
    if (!isSubscriptionProfile(update.subscriptionProfile)) {
      throw new Error('subscriptionProfile must be one of "both", "claude-only", "codex-only".');
    }
    stored.subscriptionProfile = update.subscriptionProfile;
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
  if (update.reviewContinuation !== undefined) {
    stored.reviewContinuation = Boolean(update.reviewContinuation);
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
  if (update.mergeTestReplayEnabled !== undefined) {
    stored.mergeTestReplayEnabled = Boolean(update.mergeTestReplayEnabled);
  }
  if (update.requireApproval !== undefined) {
    if (!isRequireApproval(update.requireApproval)) {
      throw new Error('requireApproval must be one of "high-risk", "surface", "always", "never".');
    }
    stored.requireApproval = update.requireApproval;
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
      throw new Error('defaultDispatchRuntime must name a dispatchable runtime.');
    }
    stored.defaultDispatchRuntime = update.defaultDispatchRuntime;
    stored.defaultDispatchRuntimeExplicit = true;
  }
  if (update.workerRuntimes !== undefined) {
    if (!Array.isArray(update.workerRuntimes) || update.workerRuntimes.length === 0 || !update.workerRuntimes.every(isDispatchRuntime)) {
      throw new Error('workerRuntimes must contain at least one dispatchable runtime.');
    }
    stored.workerRuntimes = [...new Set(update.workerRuntimes)];
  }
  if (update.codexWorkerEffort !== undefined) {
    if (!isThinkingEffort(update.codexWorkerEffort)) {
      throw new Error('codexWorkerEffort must be a valid ThinkingEffort value.');
    }
    stored.codexWorkerEffort = update.codexWorkerEffort;
  }
  if (update.claudeWorkerEffort !== undefined) {
    if (!isThinkingEffort(update.claudeWorkerEffort)) {
      throw new Error('claudeWorkerEffort must be a valid ThinkingEffort value.');
    }
    stored.claudeWorkerEffort = update.claudeWorkerEffort;
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
  if (update.crossHouseWorkerFallback !== undefined) {
    stored.crossHouseWorkerFallback = Boolean(update.crossHouseWorkerFallback);
  }
  if (update.orchestratorBackend !== undefined) {
    if (!isOrchestratorBackendSetting(update.orchestratorBackend)) {
      throw new Error('orchestratorBackend must be one of "auto", "codex", "claude", "openclaw", "hermes", "collide", "fable".');
    }
    stored.orchestratorBackend = update.orchestratorBackend;
  }
  if (update.reviewerBackend !== undefined) {
    if (!isReviewerBackendSetting(update.reviewerBackend)) {
      throw new Error('reviewerBackend must be one of "follow", "claude", "codex".');
    }
    stored.reviewerBackend = update.reviewerBackend;
  }
  if (update.packetExplainerEnabled !== undefined) {
    stored.packetExplainerEnabled = Boolean(update.packetExplainerEnabled);
  }
  if (update.quizGateEnabled !== undefined) {
    stored.quizGateEnabled = Boolean(update.quizGateEnabled);
  }
  if (update.buyinDocEnabled !== undefined) {
    stored.buyinDocEnabled = Boolean(update.buyinDocEnabled);
  }
  if (update.updateAutoApply !== undefined) {
    if (update.updateAutoApply !== 'off' && update.updateAutoApply !== 'idle') {
      throw new Error('updateAutoApply must be "off" or "idle".');
    }
    stored.updateAutoApply = update.updateAutoApply;
  }
  if (update.collideAggregator !== undefined) {
    if (!isCollideAggregator(update.collideAggregator)) {
      throw new Error('collideAggregator must be "auto", "claude", or "codex".');
    }
    stored.collideAggregator = update.collideAggregator;
  }
  if (update.productTelemetryEnabled !== undefined) stored.productTelemetryEnabled = Boolean(update.productTelemetryEnabled);
  if (update.telemetryOptIn !== undefined) {
    stored.telemetryOptIn = Boolean(update.telemetryOptIn);
  }
  if (update.crashReportsEnabled !== undefined) {
    stored.crashReportsEnabled = Boolean(update.crashReportsEnabled);
  }
  if (update.telemetryIngestUrl !== undefined) {
    if (typeof update.telemetryIngestUrl !== 'string') {
      throw new Error('telemetryIngestUrl must be a string.');
    }
    stored.telemetryIngestUrl = update.telemetryIngestUrl.trim();
  }
  if (update.branchPrefix !== undefined) {
    const cleaned = sanitizeBranchPrefix(update.branchPrefix);
    if (!cleaned) {
      throw new Error('branchPrefix must contain at least one branch-safe character.');
    }
    stored.branchPrefix = cleaned;
  }
  if (update.commitAttributionEnabled !== undefined) {
    stored.commitAttributionEnabled = Boolean(update.commitAttributionEnabled);
  }
  if (update.prLinkDestination !== undefined) {
    if (!isPrLinkDestination(update.prLinkDestination)) {
      throw new Error('prLinkDestination must be "in-app" or "browser".');
    }
    stored.prLinkDestination = update.prLinkDestination;
  }
  if (update.worktreeMaxCount !== undefined) {
    if (!Number.isFinite(update.worktreeMaxCount) || update.worktreeMaxCount < 0) {
      throw new Error('worktreeMaxCount must be a non-negative number (0 = unbounded).');
    }
    stored.worktreeMaxCount = Math.min(1000, Math.floor(update.worktreeMaxCount));
  }
  if (update.worktreeMaxTotalGb !== undefined) {
    if (!Number.isFinite(update.worktreeMaxTotalGb) || update.worktreeMaxTotalGb < 0) {
      throw new Error('worktreeMaxTotalGb must be a non-negative number (0 = unbounded).');
    }
    stored.worktreeMaxTotalGb = Math.min(10000, update.worktreeMaxTotalGb);
  }
  if (update.targetingTriage !== undefined) {
    if (!isTargetingTier(update.targetingTriage)) {
      throw new Error('targetingTriage must be { runtime: dispatch-runtime, model: string, effort: thinking-effort }.');
    }
    stored.targetingTriage = update.targetingTriage;
  }
  if (update.targetingAction !== undefined) {
    if (!isTargetingTier(update.targetingAction)) {
      throw new Error('targetingAction must be { runtime: dispatch-runtime, model: string, effort: thinking-effort }.');
    }
    stored.targetingAction = update.targetingAction;
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

export function resolveReviewContinuationSync(): boolean {
  return getOperatorDefaultsSync().values.reviewContinuation;
}

export function resolveHealBotEnabledSync(): boolean {
  return getOperatorDefaultsSync().values.healBotEnabled;
}

export function resolvePromptCachingEnabledSync(): boolean {
  return getOperatorDefaultsSync().values.promptCachingEnabled;
}

export function resolveMergeTestReplayEnabledSync(): boolean {
  return getOperatorDefaultsSync().values.mergeTestReplayEnabled;
}

export function resolveRequireApprovalSync(): RequireApproval {
  return getOperatorDefaultsSync().values.requireApproval;
}

export function resolveDefaultDispatchRuntimeSync(): OrchestratorRuntime {
  return getOperatorDefaultsSync().values.defaultDispatchRuntime;
}

export function resolveDefaultWorkerEffortSync(
  runtime: OrchestratorRuntime,
  explicitEffort?: ThinkingEffort | null,
): ThinkingEffort | undefined {
  const values = getOperatorDefaultsSync().values;
  return resolveWorkerEffortDefault({
    runtime,
    explicitEffort,
    codexWorkerEffort: values.codexWorkerEffort,
    claudeWorkerEffort: values.claudeWorkerEffort,
  });
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

export function resolveCrossHouseWorkerFallbackSync(): boolean {
  return getOperatorDefaultsSync().values.crossHouseWorkerFallback;
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

/** Which backend runs lane auto-reviews ('follow' → ride the orchestrator). */
export function resolveReviewerBackendSync(): ReviewerBackendSetting {
  return getOperatorDefaultsSync().values.reviewerBackend;
}

/** Whether packet explainer generation is enabled (#1491, default on). */
export function resolvePacketExplainerEnabledSync(): boolean {
  return getOperatorDefaultsSync().values.packetExplainerEnabled;
}

/** Whether the quiz-gated human merge is enabled (#1491, default off). */
export function resolveQuizGateEnabledSync(): boolean {
  return getOperatorDefaultsSync().values.quizGateEnabled;
}

/** Whether the auto buy-in doc on merge is enabled (#1492, default off). */
export function resolveBuyinDocEnabledSync(): boolean {
  return getOperatorDefaultsSync().values.buyinDocEnabled;
}

export function resolveCollideAggregatorSync(): CollideAggregator {
  return getOperatorDefaultsSync().values.collideAggregator;
}

/** Whether coarse product telemetry is explicitly opted in (default off). */
export function resolveProductTelemetryEnabledSync(): boolean {
  return getOperatorDefaultsSync().values.productTelemetryEnabled;
}

/** Whether crash-telemetry upload is opted in (Rock 2, default off). */
export function resolveTelemetryOptInSync(): boolean {
  return getOperatorDefaultsSync().values.telemetryOptIn;
}

/** Crash-telemetry ingest endpoint ('' = no upload). Env overrides file. */
export function resolveTelemetryIngestUrlSync(): string {
  return getOperatorDefaultsSync().values.telemetryIngestUrl;
}

/** Crash/error data-sharing toggle (default off; also gates user bug reports). */
export function resolveCrashReportsEnabledSync(): boolean {
  return getOperatorDefaultsSync().values.crashReportsEnabled;
}

/** Prefix for issue-derived packet branches (`<prefix>/<n>-<slug>`, default 'issue'). */
export function resolveBranchPrefixSync(): string {
  return getOperatorDefaultsSync().values.branchPrefix;
}

/** Whether agent worktree commits get a Co-Authored-By trailer (default off). */
export function resolveCommitAttributionEnabledSync(): boolean {
  return getOperatorDefaultsSync().values.commitAttributionEnabled;
}

/** Where a PR row opens — embedded panel or OS browser (default 'in-app'). */
export function resolvePrLinkDestinationSync(): PrLinkDestination {
  return getOperatorDefaultsSync().values.prLinkDestination;
}

/**
 * `.cortex-worktrees` retention ceilings (count + total GB) read by the
 * WorktreeManager prune seam. `0` on either axis = that axis is unbounded.
 * env > file > fallback (default 20 / 20).
 */
export function resolveWorktreeRetentionSync(): { maxCount: number; maxTotalGb: number } {
  const values = getOperatorDefaultsSync().values;
  return { maxCount: values.worktreeMaxCount, maxTotalGb: values.worktreeMaxTotalGb };
}

/** The Targeting Machine's cheap triage/rationale tier (env > file > fallback). */
export function resolveTargetingTriageSync(): TargetingTier {
  return getOperatorDefaultsSync().values.targetingTriage;
}

/** The Targeting Machine's premium "point a real agent here" tier. */
export function resolveTargetingActionSync(): TargetingTier {
  return getOperatorDefaultsSync().values.targetingAction;
}
