import { NextResponse } from 'next/server';

import {
  getOperatorDefaults,
  isCollideAggregator,
  isOrchestratorBackendSetting,
  isPrLinkDestination,
  isRequireApproval,
  isReviewerBackendSetting,
  isSubscriptionProfile,
  updateOperatorDefaults,
  type OperatorDefaults,
  type OverlapGateMode,
} from '@/lib/operator/defaults';
import { isDispatchRuntime } from '@/lib/operator/defaults-env';
import { isThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { getRuntimeAuthSnapshot } from '@/lib/runtimes/shared/auth-detect';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, max-age=0' };

function response(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: NO_STORE_HEADERS,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeUpdate(body: Record<string, unknown>): Partial<OperatorDefaults> {
  const update: Partial<OperatorDefaults> = {};

  if (body.subscriptionProfile !== undefined) {
    if (!isSubscriptionProfile(body.subscriptionProfile)) {
      throw new Error('subscriptionProfile must be one of "both", "claude-only", "codex-only".');
    }
    update.subscriptionProfile = body.subscriptionProfile;
  }

  if (body.parallelCap !== undefined) {
    const raw = body.parallelCap;
    const parsed = typeof raw === 'number'
      ? raw
      : typeof raw === 'string'
        ? Number.parseInt(raw, 10)
        : Number.NaN;
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 32) {
      throw new Error('parallelCap must be an integer between 1 and 32.');
    }
    update.parallelCap = Math.floor(parsed);
  }

  if (body.overlapGate !== undefined) {
    if (body.overlapGate !== 'advisory' && body.overlapGate !== 'strict') {
      throw new Error('overlapGate must be "advisory" or "strict".');
    }
    update.overlapGate = body.overlapGate as OverlapGateMode;
  }

  if (body.healBotEnabled !== undefined) {
    if (typeof body.healBotEnabled !== 'boolean') {
      throw new Error('healBotEnabled must be boolean.');
    }
    update.healBotEnabled = body.healBotEnabled;
  }

  if (body.supervisorAutoEscalate !== undefined) {
    if (typeof body.supervisorAutoEscalate !== 'boolean') {
      throw new Error('supervisorAutoEscalate must be boolean.');
    }
    update.supervisorAutoEscalate = body.supervisorAutoEscalate;
  }

  if (body.reviewContinuation !== undefined) {
    if (typeof body.reviewContinuation !== 'boolean') {
      throw new Error('reviewContinuation must be boolean.');
    }
    update.reviewContinuation = body.reviewContinuation;
  }

  if (body.thinkingEffort !== undefined) {
    if (!isThinkingEffort(body.thinkingEffort)) {
      throw new Error('thinkingEffort must be a valid effort level.');
    }
    update.thinkingEffort = body.thinkingEffort;
  }

  if (body.promptCachingEnabled !== undefined) {
    if (typeof body.promptCachingEnabled !== 'boolean') {
      throw new Error('promptCachingEnabled must be boolean.');
    }
    update.promptCachingEnabled = body.promptCachingEnabled;
  }

  if (body.requireApproval !== undefined) {
    if (!isRequireApproval(body.requireApproval)) {
      throw new Error('requireApproval must be one of "high-risk", "always", "never".');
    }
    update.requireApproval = body.requireApproval;
  }

  if (body.orchestratorModel !== undefined) {
    if (typeof body.orchestratorModel !== 'string' || !body.orchestratorModel.trim()) {
      throw new Error('orchestratorModel must be a non-empty string.');
    }
    update.orchestratorModel = body.orchestratorModel.trim();
  }

  if (body.defaultDispatchRuntime !== undefined) {
    // Single-source guard (mirrors the orchestratorBackend pattern below): a
    // hand-rolled list here silently rejected cursor/grok/pi even though the
    // dispatch layer + tier validator accept them (2026-07-09).
    if (!isDispatchRuntime(body.defaultDispatchRuntime)) {
      throw new Error('defaultDispatchRuntime must be one of "codex", "claude-code", "opencode", "cursor", "grok", "pi".');
    }
    update.defaultDispatchRuntime = body.defaultDispatchRuntime;
  }

  if (body.codexWorkerEffort !== undefined) {
    if (!isThinkingEffort(body.codexWorkerEffort)) {
      throw new Error('codexWorkerEffort must be a valid effort level.');
    }
    update.codexWorkerEffort = body.codexWorkerEffort;
  }

  if (body.claudeWorkerEffort !== undefined) {
    if (!isThinkingEffort(body.claudeWorkerEffort)) {
      throw new Error('claudeWorkerEffort must be a valid effort level.');
    }
    update.claudeWorkerEffort = body.claudeWorkerEffort;
  }

  if (body.defaultDispatchModel !== undefined) {
    // Any string is valid; '' clears it back to the runtime default. Use the
    // `ollama:<model>` / `lmstudio:<model>` convention to dispatch local.
    if (typeof body.defaultDispatchModel !== 'string') {
      throw new Error('defaultDispatchModel must be a string.');
    }
    update.defaultDispatchModel = body.defaultDispatchModel.trim();
  }

  if (body.localInferenceBaseUrl !== undefined) {
    if (typeof body.localInferenceBaseUrl !== 'string') {
      throw new Error('localInferenceBaseUrl must be a string.');
    }
    update.localInferenceBaseUrl = body.localInferenceBaseUrl.trim();
  }

  if (body.localEmbedModel !== undefined) {
    if (typeof body.localEmbedModel !== 'string') {
      throw new Error('localEmbedModel must be a string.');
    }
    update.localEmbedModel = body.localEmbedModel.trim();
  }

  if (body.localChatModel !== undefined) {
    if (typeof body.localChatModel !== 'string') {
      throw new Error('localChatModel must be a string.');
    }
    update.localChatModel = body.localChatModel.trim();
  }

  if (body.experimentalOpencode !== undefined) {
    if (typeof body.experimentalOpencode !== 'boolean') {
      throw new Error('experimentalOpencode must be boolean.');
    }
    update.experimentalOpencode = body.experimentalOpencode;
  }

  if (body.experimentalGemini !== undefined) {
    if (typeof body.experimentalGemini !== 'boolean') {
      throw new Error('experimentalGemini must be boolean.');
    }
    update.experimentalGemini = body.experimentalGemini;
  }

  if (body.experimentalChat !== undefined) {
    if (typeof body.experimentalChat !== 'boolean') {
      throw new Error('experimentalChat must be boolean.');
    }
    update.experimentalChat = body.experimentalChat;
  }

  if (body.experimentalCanvas !== undefined) {
    if (typeof body.experimentalCanvas !== 'boolean') {
      throw new Error('experimentalCanvas must be boolean.');
    }
    update.experimentalCanvas = body.experimentalCanvas;
  }

  if (body.classAComposer !== undefined) {
    const raw = body.classAComposer;
    if (raw !== 'auto' && raw !== 'haiku-cli' && raw !== 'sonnet-cli' && raw !== 'fastest') {
      throw new Error('classAComposer must be one of "auto", "haiku-cli", "sonnet-cli", "fastest".');
    }
    update.classAComposer = raw;
  }

  if (body.inAppOrchestratorEnabled !== undefined) {
    if (typeof body.inAppOrchestratorEnabled !== 'boolean') {
      throw new Error('inAppOrchestratorEnabled must be boolean.');
    }
    update.inAppOrchestratorEnabled = body.inAppOrchestratorEnabled;
  }
  if (body.brainUseClaudeCli !== undefined) {
    if (typeof body.brainUseClaudeCli !== 'boolean') {
      throw new Error('brainUseClaudeCli must be boolean.');
    }
    update.brainUseClaudeCli = body.brainUseClaudeCli;
  }

  if (body.workersUseBrain !== undefined) {
    const raw = body.workersUseBrain;
    if (raw !== 'off' && raw !== 'auto' && raw !== 'all') {
      throw new Error('workersUseBrain must be one of "off", "auto", "all".');
    }
    update.workersUseBrain = raw;
  }

  if (body.orchestratorBackend !== undefined) {
    const raw = body.orchestratorBackend;
    // Single-source guard from defaults.ts — a hand-rolled list here silently
    // rejected the fable backend when Slice 1 widened the union (dogfood 2026-07-02).
    if (!isOrchestratorBackendSetting(raw)) {
      throw new Error('orchestratorBackend must be one of "auto", "codex", "claude", "openclaw", "hermes", "collide", "fable", "o8".');
    }
    update.orchestratorBackend = raw;
  }

  if (body.reviewerBackend !== undefined) {
    const raw = body.reviewerBackend;
    if (!isReviewerBackendSetting(raw)) {
      throw new Error('reviewerBackend must be one of "follow", "codex", "claude".');
    }
    update.reviewerBackend = raw;
  }

  if (body.packetExplainerEnabled !== undefined) {
    if (typeof body.packetExplainerEnabled !== 'boolean') {
      throw new Error('packetExplainerEnabled must be boolean.');
    }
    update.packetExplainerEnabled = body.packetExplainerEnabled;
  }

  if (body.quizGateEnabled !== undefined) {
    if (typeof body.quizGateEnabled !== 'boolean') {
      throw new Error('quizGateEnabled must be boolean.');
    }
    update.quizGateEnabled = body.quizGateEnabled;
  }

  if (body.buyinDocEnabled !== undefined) {
    if (typeof body.buyinDocEnabled !== 'boolean') {
      throw new Error('buyinDocEnabled must be boolean.');
    }
    update.buyinDocEnabled = body.buyinDocEnabled;
  }

  if (body.autoApplyUpdates !== undefined) {
    const raw = body.autoApplyUpdates;
    if (raw !== 'off' && raw !== 'when-idle') {
      throw new Error('autoApplyUpdates must be one of "off", "when-idle".');
    }
    update.autoApplyUpdates = raw;
  }

  if (body.collideAggregator !== undefined) {
    const raw = body.collideAggregator;
    if (!isCollideAggregator(raw)) {
      throw new Error('collideAggregator must be one of "auto", "claude", "codex".');
    }
    update.collideAggregator = raw;
  }

  if (body.telemetryOptIn !== undefined) {
    if (typeof body.telemetryOptIn !== 'boolean') {
      throw new Error('telemetryOptIn must be boolean.');
    }
    update.telemetryOptIn = body.telemetryOptIn;
  }

  if (body.telemetryIngestUrl !== undefined) {
    if (typeof body.telemetryIngestUrl !== 'string') {
      throw new Error('telemetryIngestUrl must be a string.');
    }
    update.telemetryIngestUrl = body.telemetryIngestUrl.trim();
  }

  if (body.crashReportsEnabled !== undefined) {
    if (typeof body.crashReportsEnabled !== 'boolean') {
      throw new Error('crashReportsEnabled must be boolean.');
    }
    update.crashReportsEnabled = body.crashReportsEnabled;
  }

  if (body.branchPrefix !== undefined) {
    // Any string is accepted; the store sanitizes it to a branch-safe segment
    // and rejects a value that cleans to empty.
    if (typeof body.branchPrefix !== 'string') {
      throw new Error('branchPrefix must be a string.');
    }
    update.branchPrefix = body.branchPrefix;
  }

  if (body.commitAttributionEnabled !== undefined) {
    if (typeof body.commitAttributionEnabled !== 'boolean') {
      throw new Error('commitAttributionEnabled must be boolean.');
    }
    update.commitAttributionEnabled = body.commitAttributionEnabled;
  }

  if (body.prLinkDestination !== undefined) {
    if (!isPrLinkDestination(body.prLinkDestination)) {
      throw new Error('prLinkDestination must be "in-app" or "browser".');
    }
    update.prLinkDestination = body.prLinkDestination;
  }

  if (body.worktreeMaxCount !== undefined) {
    const raw = body.worktreeMaxCount;
    const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error('worktreeMaxCount must be a non-negative number (0 = unbounded).');
    }
    update.worktreeMaxCount = Math.floor(parsed);
  }

  if (body.worktreeMaxTotalGb !== undefined) {
    const raw = body.worktreeMaxTotalGb;
    const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error('worktreeMaxTotalGb must be a non-negative number (0 = unbounded).');
    }
    update.worktreeMaxTotalGb = parsed;
  }

  const validateTier = (raw: unknown, name: string): OperatorDefaults['targetingTriage'] => {
    if (!raw || typeof raw !== 'object') throw new Error(`${name} must be an object { runtime, model, effort }.`);
    const o = raw as Record<string, unknown>;
    if (
      o.runtime !== 'codex'
      && o.runtime !== 'claude-code'
      && o.runtime !== 'gemini'
      && o.runtime !== 'opencode'
      && o.runtime !== 'cursor'
      && o.runtime !== 'grok'
    ) {
      throw new Error(`${name}.runtime must be one of "codex", "claude-code", "gemini", "opencode", "cursor", "grok", "pi".`);
    }
    if (typeof o.model !== 'string') throw new Error(`${name}.model must be a string ('' = runtime default).`);
    if (!isThinkingEffort(o.effort)) throw new Error(`${name}.effort must be a valid thinking effort.`);
    return { runtime: o.runtime, model: o.model, effort: o.effort };
  };
  if (body.targetingTriage !== undefined) update.targetingTriage = validateTier(body.targetingTriage, 'targetingTriage');
  if (body.targetingAction !== undefined) update.targetingAction = validateTier(body.targetingAction, 'targetingAction');

  return update;
}

export async function GET() {
  try {
    const [data, cliAuth] = await Promise.all([
      getOperatorDefaults(),
      getRuntimeAuthSnapshot(),
    ]);
    return response({ ...data, cliAuth });
  } catch (error) {
    console.error('[panel-operator-defaults] Failed to load operator defaults:', error);
    return response({ error: 'Failed to load operator defaults.' }, 500);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    if (!isRecord(body)) {
      return response({ error: 'Invalid request body.' }, 400);
    }

    const update = normalizeUpdate(body);
    if (Object.keys(update).length === 0) {
      return response({ error: 'No supported fields in request body.' }, 400);
    }

    const [updated, cliAuth] = await Promise.all([
      updateOperatorDefaults(update),
      getRuntimeAuthSnapshot(),
    ]);
    return response({ ...updated, cliAuth });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update operator defaults.';
    console.error('[panel-operator-defaults] Failed to update operator defaults:', message);
    return response({ error: message }, 400);
  }
}
