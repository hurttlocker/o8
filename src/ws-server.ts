/**
 * Unified WebSocket server for o8 mobile.
 *
 * Runs alongside Next.js on a dynamically resolved WS port. Multiplexes all real-time data
 * over a single WS connection per mobile client:
 *
 *   Mobile Client ←WS→ This Server ←HTTP→ Next.js (sync API)
 *
 * Channels:
 *   chat    — streaming text deltas
 *   inbox   — session list updates (pushed on change)
 *   history — transcript updates (pushed on change)
 *   lane-lifecycle — lane status transitions (pushed on change)
 *   review  — review file updates (pushed on change)
 *   cortex-changes — directive / outcome / codebase-memory writes (#840)
 *   pong    — keepalive response
 *
 * The client sends:
 *   { type: "subscribe", sessionKey: "..." }
 *   { type: "switch-session", sessionKey: "..." }
 *   { type: "ping" }
 *
 * Delivery semantics per channel (backpressure behavior):
 *
 *   chat (delta)      — LOSSY: intermediate deltas may be dropped. chat.done
 *                        delivers final text and history safety-net recovers.
 *   chat (done/error) — DURABLE: queued under backpressure and flushed when
 *                        pressure clears (max 32 queued messages per client).
 *   inbox             — DURABLE: queued under backpressure. Also recovered by
 *                        10s safety-net polling.
 *   history           — DURABLE: queued under backpressure. Also recovered by
 *                        8s safety-net polling.
 *   terminal (data)   — LOSSY: inherently best-effort like a real PTY. Frame
 *                        drops are invisible to the user.
 *   terminal (other)  — DURABLE: lifecycle events (created/exited/error) queued.
 *   agent-lifecycle   — DURABLE: queued under backpressure.
 *   lane-lifecycle    — DURABLE: queued under backpressure.
 *   review            — DURABLE: queued under backpressure.
 *   conflicts         — DURABLE: queued under backpressure.
 *   artifacts         — DURABLE: queued under backpressure. Fires when an
 *                       agent records a before/after proof still (#1147).
 *   pong              — LOSSY: keepalive response, loss is harmless.
 */

import { watch, existsSync } from 'node:fs';
import { readFile, stat, access } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { getDataDir, migrateDataDirOnce } from '@/lib/data-dir-migration';

migrateDataDirOnce();

import { expireStaleApprovals } from '@/lib/approvals/store';
import { getDb } from '@/lib/db';
import { resolvePortInfo } from '@/lib/panel/api-port';
import { getInstanceIdentity } from '@/lib/panel/instance-identity';
import {
  startAgentSession,
  updateAgentStatus,
  touchAgentSession,
  stopAgentSession,
  sweepStaleAgentSession,
  getAgentSession,
  persistAgentSession,
  loadSymonScopeGrant,
  clearSymonScopeGrant,
  scopeGrantMatchesClient,
  scopeSymonToolArgs,
  type AgentSessionStatus,
  type SymonScopeGrant,
} from '@/lib/mobile/symon-agent-registry';
import {
  SymonAsyncActionTracker,
  SymonConfirmationTracker,
  ToolCallTracker,
  confirmationOutcomeFromResolution,
  parseSymonPendingConfirmation,
  symonToolTimeoutMs,
  type CompletedToolCall,
  type PendingToolCall,
  type SymonActionComplete,
  type SymonConfirmationOutcome,
  type SymonConfirmationResolution,
  type SymonPendingConfirmation,
  type SymonProtocolVersion,
  type SymonToolRelayResult,
} from '@/lib/mobile/symon-tool-relay';
import {
  appendSymonTextTranscript,
  dropSymonTextSession,
  formatSymonTextPlannerPrompt,
  loadSymonTextSession,
  type SymonTextSessionRecord,
} from '@/lib/mobile/symon-text-session-store';
import { chainOnKey } from '@/lib/util/keyed-promise-chain';
import { getOrCreateWsToken, WS_TOKEN_PATH } from '@/lib/ws-auth';
import { findRepoByLocalPath } from '@/lib/repos/registry';
import '@/lib/ws-runtime-env';
import { resolveWorktreeRootLayout } from '@/lib/worktree/root-layout';
import { WebSocketServer, WebSocket } from 'ws';
import type { BrowserAttachmentSummary } from '@/lib/browser/types';
import { getAttachedBrowserSummary, setAttachedBrowserSummary } from './lib/browser/attachment-state';
import { getBrowserProvider } from './lib/browser/inventory';
import type { CommandCenterSnapshot } from './lib/command-center/snapshot';
import type { MobileInboxSnapshot, MobileOrchestratorThread, MobileTranscriptEntry } from './lib/mobile/types';
import {
  listMobileOrchestratorRevealRequests,
  listMobileOrchestratorThreads,
  markMobileOrchestratorThreadFailed,
  mobileOrchestratorThreadHistoryStatTokenAsync,
  truncateMobileOrchestratorThreadFromMessage,
  upsertMobileOrchestratorAssistantMessage,
  writeOrchestratorBackendSessionId,
} from './lib/mobile/orchestrator-thread-history';
import { OrchestratorThreadProjectError } from './lib/mobile/orchestrator-thread-project';
import { persistOrchestratorThreadUserMessageFromWire } from './lib/ws-server/orchestrator-thread-send';
import { getLiveReviewChangeSet } from './lib/review/live-changes';
import { deriveIdempotencyKey, withIdempotency } from './lib/orchestrator/idempotency-store';
import { isManualThinkingEffort, type ManualThinkingEffort } from './lib/orchestrator/thinking-effort';
import { withSessionRules } from './lib/orchestrator/session-rules-prompt';
import { buildBackendSwitchCarryPrelude } from './lib/orchestrator/backend-switch-carry';
import { resolveOrchestratorTranscriptMessage } from './lib/orchestrator/composer-wire';
import {
  resolveOrchestratorMessageRepoPath,
  resolveOrchestratorRepoPath,
} from './lib/orchestrator/repo-path';
import { orchestratorReplay } from './lib/orchestrator/replay-buffer';
import {
  rehydrateOrchestratorSessions,
} from './lib/lane/orchestrator-session';
import { rehydrateCodexOrchestratorTurns } from './lib/lane/codex-orchestrator-session';
import {
  getActiveOrchestratorBackend,
  getOrchestratorBackend,
  resolveOrchestratorBackendId,
} from './lib/lane/orchestrator-backends/registry';
import { isMeteredOrchestratorBackend } from './lib/lane/orchestrator-backends/billing';
import {
  buildCrossHouseFallbackMessage,
  isRuntimeQuotaLimitError,
  resolveCrossHouseFallback,
  resolveCrossHouseFallbackForQuota,
} from './lib/orchestrator/cross-house-policy';
import { isOrchestratorBackendId, type OrchestratorBackend, type OrchestratorBackendId } from './lib/lane/orchestrator-backends/types';
import type { OrchestratorTurnRecord } from './lib/lane/orchestrator-crash-survival';
import type { OrchestratorEvent } from './lib/lane/orchestrator-stream-events';
import {
  ActiveOrchestratorRouteRegistry,
  promoteOrchestratorSubscribers,
  type ActiveOrchestratorRouteHandle,
  type OrchestratorSubscriptionRoute,
} from './lib/lane/orchestrator-subscription-promotion';
import {
  orchestratorModeAllowsBackendFallback,
  resolveOrchestratorExecutionBackendId,
  sendOrchestratorBackendTurn,
} from './lib/lane/orchestrator-send-entry';
import {
  startSupervisorLoop,
  stopSupervisorLoop,
  registerWatchedAgent,
  unregisterWatchedAgent,
  getWatchedAgents,
  ingestAgentCompletionSignal,
  type SupervisorCallbacks,
  type AgentUpdateEvent,
} from './lib/supervisor/agent-supervisor';
import { isTerminalLaneStatus } from './lib/lane/types';
import type { Lane } from './lib/lane/types';
import { getPacketTailBatch, type PacketTailEvent } from './lib/lane/packet-tail';
import { probeNoChangesProduced } from './lib/lane/no-changes-produced';
import {
  hasFreshSelfReviewTranscriptActivity,
  preserveSelfReviewStallWork,
  probeSelfReviewStall,
  resetSelfReviewStallGuard,
  type SelfReviewStallDecision,
} from './lib/supervisor/self-review-stall-guard';
import { invalidateReviewingLaneForWorkerActivity } from './lib/supervisor/review-invalidation';
import {
  enqueueSupervisorInboxItem,
  startHealBot,
  type SupervisorInboxKind,
  type SupervisorInboxPayload,
} from './lib/supervisor/heal-bot';
import {
  isSilentExitDetectorEnabled,
  startSilentExitDetector,
} from './lib/supervisor/silent-exit-detector';
import {
  getOperatorDefaultsSync,
  resolveHealBotEnabledSync,
  resolveInAppOrchestratorEnabledSync,
  resolveReviewContinuationSync,
  resolveSupervisorAutoEscalateSync,
} from './lib/operator/defaults';
import { startWorktreeReaper, stopWorktreeReaper } from './lib/lane/worktree-reaper';
import { startLaneZombieReaper, stopLaneZombieReaper } from './lib/lane/reaper';
import { collectPersistedTmuxSessions } from './lib/terminal/state-store';
import { selectOrphanDashSessions, type DashSessionInfo } from './lib/terminal/dash-gc';
import { resolveDeviceByToken, isDeviceActive, isTokenRevoked, type MobileDevice } from './lib/mobile/device-registry';
import { startRelayConnectorIfEnabled, stopRelayConnector } from './lib/mobile/relay-connector';
import {
  startMachineAttachSupervisor,
  stopMachineAttachSupervisor,
} from './lib/connect/machine-attach-supervisor';
import { getServerIdentity } from './lib/mobile/e2ee-identity';
import { startServerHandshake, completeServerHandshake, type ServerHandshake } from './lib/mobile/e2ee-channel';
import { encryptFrame, decryptFrame, isEncryptedFrame } from './lib/mobile/e2ee-crypto';
import {
  buildMobileInboxDelta,
  MOBILE_INBOX_DELTA_CAPABILITY,
} from './lib/mobile/inbox-delta';
import { isLoopbackAddress } from './lib/auth/loopback-request';
import { bootCompactorScheduler } from './lib/cortex/compactor-scheduler';
import { bootAutomationsScheduler } from './lib/automations/scheduler';
import type {
  LaneLifecycleEventPayload,
  RealtimeBatchMessage,
  RealtimeEventEnvelope,
  RealtimeHealthDescriptor,
  RealtimeInternalRequest,
  RealtimeMutationRecord,
  RealtimeStreamKey,
  RealtimeSubscription,
} from './lib/realtime/types';
import {
  canAttemptRealtimeBridge,
  createRealtimeBridgeBackoffState,
  getRealtimeBridgeRetryDelay,
  recordRealtimeBridgeFailure,
  recordRealtimeBridgeSuccess,
} from './lib/realtime/bridge-backoff';
import { isWorktreeNoise, shouldRunConflictScan } from './lib/ws-server/conflict-gate';
import { WsWatchdog } from './lib/ws-server/health-watchdog';
import {
  sanitizePtyEnv,
  resolvePreferredShell,
  resolveTmuxBinary,
  tmuxSessionExists,
  isDashTerminalSession,
} from './lib/ws-server/pty-support';
import { parseGitWorktreeList, shortHome } from './lib/ws-server/git-worktrees';
import {
  BACKPRESSURE_LIMIT,
  BACKPRESSURE_QUEUE_LIMIT,
  BACKPRESSURE_FLUSH_MS,
  isLossyMessage,
} from './lib/ws-server/channels';
import {
  FETCH_TIMEOUT_MS,
  buildNextUrl,
  fetchWithRetry,
  fetchNextJson,
} from './lib/ws-server/next-fetch';
import {
  decideStalePortRecovery,
  fetchWsHealthIdentity,
} from './lib/ws-server/stale-port-recovery';
import { buildWsHealthPayload } from './lib/ws-server/health-payload';
import {
  createInlineTerminalHost,
  createChildTerminalHost,
  type TerminalHost,
} from './lib/ws-server/terminal-host-client';
import {
  duplicateOrchestratorSendAck,
  orchestratorCommandAckCorrelation,
  orchestratorInterruptAckDisposition,
  orchestratorSendIdempotencyScope,
  resolveOrchestratorCommandCorrelationId,
  type OrchestratorInterruptAckState,
  type OrchestratorSendAckState,
} from './lib/ws-server/orchestrator-command-idempotency';
import { installProcessCrashCapture } from './lib/telemetry/crash-capture';
import { initSentryNode } from './lib/telemetry/sentry-node';

installProcessCrashCapture('ws-server');
// Sentry (dormant unless PACKAGED + a DSN was baked). Fire-and-forget; the
// local JSONL crash capture above is independent and always runs.
void initSentryNode('ws');

const execFileAsync = promisify(execFile);

// Async existence check — never blocks the shared event loop for FS calls on
// per-message / per-poll hot paths (the #1498 exposure class). Startup-only
// probes may still use existsSync.
async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// Read repo registry directly (avoid importing registry.ts which uses 'server-only')
async function listRepoPaths(): Promise<string[]> {
  try {
    const registryPath = join(getDataDir(), 'repos.json');
    const raw = await readFile(registryPath, 'utf-8');
    const store = JSON.parse(raw) as { repos?: Array<{ localPath?: string }> };
    return (store.repos ?? []).map(r => r.localPath).filter(Boolean) as string[];
  } catch {
    return [];
  }
}

// ── node-pty + terminal-host (#1498 follow-up) ──
// PTYs are spawned through a TerminalHost seam. Default 'inline' (node-pty in
// this process — historical behavior). O8_TERMINAL_HOST=child forks a separate
// terminal-host process so a PTY wedge or runaway data pump in either process
// can't freeze the other's event loop. WS protocol is byte-identical either
// way. Default is inline: the child path is built + fork-tested in dev but not
// yet proven in a packaged build, so it's opt-in.
let terminalHost: TerminalHost | null = null;
const TERMINAL_HOST_MODE: 'inline' | 'child' =
  (process.env.O8_TERMINAL_HOST ?? '').trim().toLowerCase() === 'child' ? 'child' : 'inline';

if (TERMINAL_HOST_MODE === 'child') {
  try {
    terminalHost = createChildTerminalHost({ log: (m) => console.log(`[terminal-host] ${m}`) });
    console.log('[ws-server] terminal-host: child mode (forked terminal-host process)');
  } catch (err) {
    console.warn(`[ws-server] terminal-host child failed to start — falling back to inline: ${err instanceof Error ? err.message : String(err)}`);
    terminalHost = null; // inline path below picks up when node-pty loads
  }
}

void import('node-pty')
  .then((mod) => {
    // Inline mode (or child fallback): back the host with in-process node-pty.
    if (!terminalHost) {
      terminalHost = createInlineTerminalHost(mod);
    }
    console.log('[ws-server] node-pty loaded — terminal feature available');
  })
  .catch(() => {
    console.log('[ws-server] node-pty not available — terminal feature disabled');
  });

// ── Config ──

const INSTANCE_IDENTITY = getInstanceIdentity();
const { wsPort: WS_PORT } = INSTANCE_IDENTITY;
const PING_INTERVAL_MS = 25_000;
// Event-loop lag watchdog (#1498 structural follow-up). ws-server pumps every
// mobile client, PTY, and orchestrator stream on this one loop; a sync wedge
// freezes them all. Sample loop lag; log + count sustained wedges. Cheap when
// healthy, queryable via /health.
const wsWatchdog = new WsWatchdog();

interface RuntimeTranscriptApiEntry {
  id: string;
  role: string;
  text: string;
  type?: string;
  timestamp: number;
  timestampLabel: string;
  toolName?: string;
  filePath?: string;
}

// ── Boot readiness probe ──
// Poll /api/panel/status (allowlisted — no bearer token needed) until Next.js answers
// with a 200, or until the timeout elapses. This prevents the "fetch failed" storm that
// occurs when ws-server boots before Next's request handler is listening.
const NEXT_READY_POLL_MS = 250;
const NEXT_READY_TIMEOUT_MS = 10_000;

async function waitForNextReady(): Promise<void> {
  const url = buildNextUrl('/api/panel/status');
  const deadline = Date.now() + NEXT_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(NEXT_READY_POLL_MS) });
      if (res.ok) return;
    } catch {
      // ECONNREFUSED / fetch failed — Next not up yet; keep polling
    }
    await new Promise<void>((resolve) => { setTimeout(resolve, NEXT_READY_POLL_MS); });
  }
  console.warn('[ws-server] Next.js did not become ready within 10s — proceeding anyway');
}

async function fetchCommandCenterSnapshot(fresh = false): Promise<CommandCenterSnapshot> {
  const searchParams = new URLSearchParams();
  if (fresh) searchParams.set('fresh', '1');
  return fetchNextJson<CommandCenterSnapshot>('/api/command-center/snapshot', { searchParams });
}

async function fetchBrowserInventorySnapshot() {
  return fetchNextJson<CommandCenterSnapshot['browserInventory']>('/api/browser/inventory');
}

async function fetchRuntimeInventorySnapshot(fresh = false) {
  const searchParams = new URLSearchParams();
  if (fresh) searchParams.set('fresh', '1');
  return fetchNextJson<CommandCenterSnapshot['fleet']>('/api/runtime/inventory', { searchParams });
}

async function fetchRuntimeTranscript(sessionKey: string, limit: number) {
  const searchParams = new URLSearchParams({
    sessionKey,
    limit: String(limit),
  });
  const payload = await fetchNextJson<{ transcript: RuntimeTranscriptApiEntry[] }>('/api/runtime/transcript', {
    searchParams,
  });
  return payload.transcript ?? [];
}

async function triggerHeadlessSprintTick(releasePacketIds?: string[]) {
  return fetchNextJson<{ ok: boolean }>('/api/orchestrator/headless-tick', {
    method: 'POST',
    body: releasePacketIds && releasePacketIds.length > 0 ? { releasePacketIds } : {},
    // #1293 — a real tick can take 20-30s (per-packet git worktree add + fetch +
    // rebase onto origin). The server caps itself at TICK_DEADLINE_MS = 30s
    // (headless-loop.ts) and its singleton prevents overlapping/duplicate ticks,
    // so the only cost of a too-short fetch timeout is false "Tick bridge failed:
    // operation aborted due to timeout" noise that masks real failures. Hold the
    // fetch just above the server deadline so it reflects the actual outcome.
    timeoutMs: 35_000,
  });
}

async function ensureReviewDrainStarted() {
  return fetchNextJson<{ ok: boolean }>('/api/review/auto-review', {
    method: 'POST',
    body: { action: 'start' },
    timeoutMs: 8_000,
  });
}

async function enqueueAutoReview(laneId: string) {
  return fetchNextJson<{ ok: boolean }>('/api/review/auto-review', {
    method: 'POST',
    body: { action: 'enqueue', laneId },
    timeoutMs: 8_000,
  });
}

function truncateSupervisorText(value: string, limit = 300): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) return '';
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}...`;
}

async function readGitSummary(cwd: string, baseBranch?: string | null): Promise<{ lastCommit: string; diffStat: string }> {
  let lastCommit = 'Unavailable.';
  let diffStat = 'Unavailable.';

  try {
    const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%H %s'], {
      cwd,
      timeout: 15_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    lastCommit = stdout.trim() || lastCommit;
  } catch {
    // Best effort only.
  }

  const diffArgs = baseBranch?.trim()
    ? ['diff', '--stat', `${baseBranch.trim()}...HEAD`]
    : ['diff', '--stat', 'HEAD~1'];
  try {
    const { stdout } = await execFileAsync('git', diffArgs, {
      cwd,
      timeout: 15_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    diffStat = stdout.trim() || 'No diff stat available.';
  } catch {
    try {
      const { stdout } = await execFileAsync('git', ['diff', '--stat', 'HEAD~1'], {
        cwd,
        timeout: 15_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      diffStat = stdout.trim() || diffStat;
    } catch {
      // Leave fallback text in place.
    }
  }

  return { lastCommit, diffStat };
}

async function buildTranscriptTail(sessionKey: string, limit = 8): Promise<string> {
  try {
    const entries = await fetchRuntimeTranscript(sessionKey, limit);
    const formatted = entries
      .map((entry) => `[${entry.timestampLabel ?? '?'}] ${entry.role}: ${truncateSupervisorText(entry.text, 240)}`)
      .join('\n');
    return formatted || 'No transcript available.';
  } catch {
    return 'No transcript available.';
  }
}

async function buildSupervisorInboxPayload(input: {
  laneId: string;
  worktreePath: string;
  sessionKey: string;
  baseBranch?: string | null;
  packetTitle?: string | null;
  packetReferenceLabel?: string | null;
  verificationKind?: string | null;
  attempts?: string | null;
  error: string;
  note?: string | null;
  retryError?: string | null;
}): Promise<SupervisorInboxPayload> {
  const [transcriptTail, gitSummary] = await Promise.all([
    buildTranscriptTail(input.sessionKey),
    readGitSummary(input.worktreePath, input.baseBranch),
  ]);

  return {
    laneId: input.laneId,
    worktreePath: input.worktreePath,
    sessionKey: input.sessionKey,
    surfaceId: input.sessionKey,
    baseBranch: input.baseBranch ?? null,
    packetTitle: input.packetTitle ?? null,
    packetReferenceLabel: input.packetReferenceLabel ?? null,
    verificationKind: input.verificationKind ?? null,
    attempts: input.attempts ?? null,
    error: input.error,
    diffStat: gitSummary.diffStat,
    lastCommit: gitSummary.lastCommit,
    transcriptTail,
    note: input.note ?? null,
    retryError: input.retryError ?? null,
  };
}

async function enqueueVerificationFailureInboxItem(input: {
  repoPath: string;
  packetId?: string | null;
  kind: SupervisorInboxKind;
  laneId: string;
  worktreePath: string;
  sessionKey: string;
  baseBranch?: string | null;
  packetTitle?: string | null;
  packetReferenceLabel?: string | null;
  verificationKind?: string | null;
  attempts?: string | null;
  error: string;
  note?: string | null;
  retryError?: string | null;
}): Promise<string> {
  const payload = await buildSupervisorInboxPayload(input);
  const inboxId = enqueueSupervisorInboxItem({
    repoPath: input.repoPath,
    packetId: input.packetId ?? null,
    kind: input.kind,
    payload,
  });
  console.log(`[supervisor] Enqueued inbox item ${inboxId} for ${input.repoPath} (${input.kind})`);
  return inboxId;
}

async function handleCodexSelfReviewProgress(surfaceId: string, lastMessage: string): Promise<void> {
  if (await invalidateReviewingLaneForWorkerActivity({
    surfaceId,
    source: 'transcript_progress',
    lastMessage,
  })) {
    resetSelfReviewStallGuard(surfaceId);
    return;
  }

  const watched = getWatchedAgents().find((agent) => agent.surfaceId === surfaceId);
  const { findLaneBySession, updateLane } = await import('@/lib/lane/registry');
  const lane = findLaneBySession(surfaceId);
  if (!lane || lane.runtime !== 'codex' || lane.status !== 'running' || !lane.packetId) {
    resetSelfReviewStallGuard(surfaceId);
    return;
  }

  const transcript = await fetchRuntimeTranscript(surfaceId, 80).catch(() => [{
    id: `progress-${Date.now()}`,
    role: 'assistant',
    text: lastMessage,
    timestamp: Date.now(),
    timestampLabel: new Date().toLocaleTimeString(),
  } satisfies RuntimeTranscriptApiEntry]);

  const decision = await probeSelfReviewStall({
    surfaceId,
    lane,
    transcript,
    startedAt: watched?.registeredAt ?? null,
  });

  if (decision.kind === 'signal-stall') {
    updateLane(lane.id, {
      lastEventAt: new Date().toISOString(),
      lastEventLabel: 'self_review_stall_detected',
    }, 'system');

    // Count stalls per PACKET (a per-lane count resets on every redispatch — the
    // bug). Under the cap, escalate to the orchestrator as before (a one-off
    // stall may be legitimately fixable). AT the cap, drive the packet terminal
    // (held + awaiting_human) and STOP escalating — getDispatchBlocker blocks a
    // held packet, so it can never infinitely re-dispatch again.
    const { withLockedState } = await import('@/lib/orchestrator/control-plane');
    const { setLaneStatus } = await import('@/lib/lane/registry');
    const stallPacketId = lane.packetId;
    let stallExhausted = false;
    if (stallPacketId) {
      await withLockedState((state) => {
        const packet = state.packets.find((candidate) => candidate.id === stallPacketId);
        if (!packet) return;
        const next = (packet.stallRetries ?? 0) + 1;
        packet.stallRetries = next;
        if (next >= STALL_RETRY_CAP) {
          packet.queueState = 'held';
          packet.status = 'blocked';
          packet.blockedReason = 'stall_retry_exhausted';
          packet.lastEventAt = new Date().toISOString();
          packet.lastEventLabel = 'stall_retry_exhausted';
          packet.lane = null;
          stallExhausted = true;
        }
      });
    }

    if (stallExhausted) {
      setLaneStatus(lane.id, 'awaiting_input', 'system', 'stall_retry_exhausted');
      const minutes = Math.round(decision.runningMs / 60_000);
      broadcast({
        channel: 'supervisor',
        event: 'agent-update',
        data: {
          surfaceId,
          name: lane.label,
          status: 'stuck',
          detail: `Held after ${STALL_RETRY_CAP} self-review stalls (last ${minutes}m, no commit) — needs operator attention, no auto-redispatch.`,
          repoPath: lane.repoPath,
        } satisfies AgentUpdateEvent,
      });
      console.warn(`[supervisor] Stall-retry cap (${STALL_RETRY_CAP}) reached for packet ${stallPacketId}; lane ${lane.id} held for operator — NO re-dispatch.`);
    } else {
      broadcastSelfReviewStallSignal(surfaceId, lane, decision);
    }
    return;
  }

  if (decision.kind === 'force-review') {
    await forceCodexSelfReviewToReview(surfaceId, lane, decision);
  }
}

// Bound the self-review stall→requeue loop (2026-06-22): after this many stalls
// on ONE packet, hold it for the operator instead of escalating/re-dispatching
// forever. The bug it fixes: a stalling packet re-dispatched ~4× in a loop
// because the stall path never counted attempts (only the failure path did).
const STALL_RETRY_CAP = 2;

function broadcastSelfReviewStallSignal(
  surfaceId: string,
  lane: Lane,
  decision: Extract<SelfReviewStallDecision, { kind: 'signal-stall' }>,
): void {
  const minutes = Math.round(decision.runningMs / 60_000);
  const detail = `Agent appears stalled on self-review after ${minutes}m with no commit.`;
  console.warn(`[supervisor] ${detail} lane=${lane.id} session=${surfaceId}`);
  broadcast({
    channel: 'supervisor',
    event: 'agent-update',
    data: {
      surfaceId,
      name: lane.label,
      status: 'stuck',
      detail,
      repoPath: lane.repoPath,
    } satisfies AgentUpdateEvent,
  });
  queueOrchestratorEscalation(
    lane.repoPath,
    [
      `[SUPERVISOR] Agent "${lane.label}" (${surfaceId}) appears stalled on self-review.`,
      `Lane: ${lane.id}`,
      `Reason: ${decision.reason}`,
      `Running for: ${minutes}m`,
      '',
      'No automatic failure was triggered yet. If the worktree already verifies, the self-review guard will force a review transition after its deadline.',
    ].join('\n'),
  );
}

async function forceCodexSelfReviewToReview(
  surfaceId: string,
  lane: Lane,
  decision: Extract<SelfReviewStallDecision, { kind: 'force-review' }>,
): Promise<void> {
  const cwd = decision.cwd || lane.worktreePath || lane.repoPath;
  console.warn(`[supervisor] Forcing Codex self-review stall to review lane=${lane.id} session=${surfaceId}: ${decision.reason}`);

  const preservation = await preserveSelfReviewStallWork(lane, cwd);
  if (await yieldSelfReviewForceToFreshActivity(surfaceId, lane)) return;
  if (preservation.error) {
    await parkSelfReviewStallForOrchestrator(
      surfaceId,
      lane,
      `Auto-commit failed: ${preservation.error}`,
      preservation.captureRef,
    );
    return;
  }

  if (!preservation.hasReviewableDiff) {
    await parkSelfReviewStallForOrchestrator(
      surfaceId,
      lane,
      'No reviewable commit remained after preserving the worktree.',
      preservation.captureRef,
    );
    return;
  }

  const { runCompletionVerification } = await import('@/lib/supervisor/completion-verification');
  const verification = await runCompletionVerification(cwd, lane.baseBranch);
  if (await yieldSelfReviewForceToFreshActivity(surfaceId, lane)) return;
  if (!verification.ok) {
    await parkSelfReviewStallForOrchestrator(
      surfaceId,
      lane,
      `Preserved work failed ${verification.kind}; operator review is required.`,
      preservation.captureRef,
    );
    return;
  }

  if (lane.packetId) {
    try {
      const { capturePacketCompletionContext } = await import('@/lib/orchestrator/context-relay');
      await capturePacketCompletionContext(lane.packetId, surfaceId);
    } catch (error) {
      console.error(`[context-relay] Failed to capture self-review stall context for packet ${lane.packetId}:`, error);
    }
  }

  try {
    await fetchWithRetry(buildNextUrl('/api/runtime/action'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'interrupt', surfaceId }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (error) {
    console.warn(`[supervisor] Failed to interrupt self-review stalled agent ${surfaceId}:`, error);
  }

  unregisterWatchedAgent(surfaceId);
  const { updateLane } = await import('@/lib/lane/registry');
  const updated = updateLane(lane.id, {
    status: 'reviewing',
    sessionKey: null,
    lastEventAt: new Date().toISOString(),
    lastEventLabel: 'self_review_stall_forced',
  }, 'system');
  if (updated) {
    await enqueueAutoReview(updated.id);
    await triggerHeadlessSprintTick(updated.packetId ? [updated.packetId] : undefined);
    queueReviewContinuation(updated);
  }

  resetSelfReviewStallGuard(surfaceId);
  broadcast({
    channel: 'supervisor',
    event: 'agent-update',
    data: {
      surfaceId,
      name: lane.label,
      status: 'completed',
      detail: preservation.committed
        ? 'Self-review stalled after verification; worktree was committed and moved to review.'
        : 'Self-review stalled after verification; existing commit was moved to review.',
      repoPath: lane.repoPath,
    } satisfies AgentUpdateEvent,
  });
}

async function yieldSelfReviewForceToFreshActivity(surfaceId: string, lane: Lane): Promise<boolean> {
  if (!(await hasFreshSelfReviewTranscriptActivity(surfaceId))) return false;
  resetSelfReviewStallGuard(surfaceId);
  console.log(
    `[supervisor] Self-review force deferred for lane=${lane.id} session=${surfaceId}: transcript activity resumed.`,
  );
  return true;
}

async function parkSelfReviewStallForOrchestrator(
  surfaceId: string,
  lane: Lane,
  reason: string,
  captureRef?: string,
): Promise<void> {
  const { appendEvent, setLaneStatus } = await import('@/lib/lane/registry');
  appendEvent(lane.id, 'update', 'system', {
    event: 'self_review_stall_escalated',
    reason,
    branch: lane.branch,
    worktreePath: lane.worktreePath,
    captureRef: captureRef ?? null,
  });
  setLaneStatus(
    lane.id,
    'awaiting_orchestrator',
    'system',
    'self_review_stall_needs_orchestrator',
  );
  unregisterWatchedAgent(surfaceId);
  resetSelfReviewStallGuard(surfaceId);

  const captureNote = captureRef ? `Recovery ref: ${captureRef}` : 'The lane worktree and branch remain intact.';
  const detail = `Self-review stall preserved and escalated: ${reason}`;
  console.warn(`[supervisor] ${detail} lane=${lane.id} session=${surfaceId}`);
  broadcast({
    channel: 'supervisor',
    event: 'agent-update',
    data: {
      surfaceId,
      name: lane.label,
      status: 'stuck',
      detail,
      repoPath: lane.repoPath,
    } satisfies AgentUpdateEvent,
  });
  queueOrchestratorEscalation(
    lane.repoPath,
    [
      `[SUPERVISOR] Agent "${lane.label}" (${surfaceId}) reached the self-review idle deadline.`,
      `Lane: ${lane.id}`,
      `Reason: ${reason}`,
      `Branch: ${lane.branch}`,
      captureNote,
      '',
      'The lane is awaiting orchestrator attention. Its work was preserved and was not archived.',
    ].join('\n'),
  );
}

// ── Types ──

interface ChatDelta {
  runId: string;
  sessionKey: string;
  seq: number;
  state: 'delta' | 'done' | 'error' | 'aborted';
  message?: { role: string; content: Array<{ type: string; text?: string }>; timestamp: number };
  partialText?: string;
  error?: string;
}

interface ClientState {
  id: string;
  ws: WebSocket;
  sessionKey: string | null;
  inboxEtag: string | null;
  lastHistoryId: string | null;
  alive: boolean;
  terminalSessions: Set<string>;
  realtimeSubscriptions: RealtimeSubscription[];
  realtimeCapabilities: Set<string>;
  packetTailSubscriptions: Set<string>;
  /** Queued durable messages waiting for backpressure to clear */
  backpressureQueue: string[];
  /** Timer that periodically flushes the backpressure queue */
  flushTimer: ReturnType<typeof setInterval> | null;
  /** Per-device id (#5) — set for per-device-token connections; drives revoke-disconnect. */
  deviceId?: string | null;
  /** Credential class proven during the WS upgrade; Symon scope grants bind to it. */
  authKind: 'operator' | 'device';
  /** Mobile E2EE channel state (#5) — undefined for loopback/legacy (plaintext). */
  e2ee?: E2eeConnectionState;
}

/**
 * #5 mobile E2EE per-connection state. `awaiting-init` — hello sent, waiting for
 * the client's e2ee-init (or the fallback timer → plaintext). `encrypted` — key
 * agreed, every frame is wrapped. Absent entirely = plaintext (loopback/legacy).
 */
interface E2eeConnectionState {
  state: 'awaiting-init' | 'encrypted';
  handshake?: ServerHandshake;
  sessionKey?: Uint8Array;
  /** Falls back to plaintext if the client never completes the handshake. */
  helloTimer?: ReturnType<typeof setTimeout>;
}

async function getMobileInboxSnapshot(options: { fresh?: boolean } = {}) {
  const searchParams = new URLSearchParams();
  if (options.fresh) searchParams.set('fresh', '1');
  return fetchNextJson<MobileInboxSnapshot>('/api/mobile/inbox', { searchParams });
}

async function getSessionTranscript(_sessionKey: string, _limit: number, _fresh: boolean) {
  void _sessionKey;
  void _limit;
  void _fresh;
  return [] as MobileTranscriptEntry[];
}

// ── Terminal attachment state ──

interface TerminalAttachment {
  id: string;
  sessionName: string;
  kind: 'dash-shell' | 'tmux-attach' | 'managed-process';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ptyProcess: any; // node-pty IPty
  clientIds: Set<string>;
  cols: number;
  rows: number;
  batchBuffer: string;
  batchTimer: ReturnType<typeof setTimeout> | null;
  lastOutputAt: number; // timestamp of last PTY output (for stall detection)
  createdAt: number;    // timestamp of terminal creation
  orphanTimer: ReturnType<typeof setTimeout> | null;
  scrollbackChunks: string[];
  scrollbackBytes: number;
  cwd?: string;
  commandHint?: string;
}

interface InternalTerminalSpawnPayload {
  sessionName?: string;
  shellCommand?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

interface InternalTerminalSignalPayload {
  sessionName?: string;
  signal?: string;
}

const terminalAttachments = new Map<string, TerminalAttachment>();
const TERMINAL_BATCH_MS = 16; // batch PTY output every 16ms (60fps)
const DASH_SESSION_ORPHAN_TTL_MS = 30 * 60 * 1000;
const TERMINAL_SCROLLBACK_MAX_BYTES = 512 * 1024;
const pendingDashSessions = new Map<string, { cols: number; rows: number; cwd?: string }>();

// ── Orchestrator channel state ──

// Keyed by `${clientId}::${backend}::${agent}` — one client can hold a
// subscription per backend AND per openclaw agent at once (the default
// Orchestrator tab on codex AND multiple openclaw agent groups, live together).
// `agent` is '' for codex/claude. `sessionName` is itself backend+agent-distinct,
// so event broadcast matches on it.
const orchestratorSubscriptions = new Map<string, OrchestratorSubscriptionRoute>();
const activeOrchestratorRoutes = new ActiveOrchestratorRouteRegistry();

// #624 — In-flight AbortControllers keyed by `${repoPath}::${backend}::${agent}::${threadId}`.
// Attached when an orchestrator-send turn starts; orchestrator-interrupt calls
// .abort() on the matching entry to terminate the streaming subprocess within
// 1-2s. Per-backend, per-openclaw-agent, and per thoughts thread so concurrent
// turns on the same repo don't clobber each other. Entries are removed when the
// turn resolves.
const orchestratorInflightAborts = new Map<string, AbortController>();
// Exact optimistic user-message ids currently being undone. The send handler
// checks this before every durable append so an abort racing a final stream
// flush cannot resurrect the turn after the transcript was rewound.
const undoneOrchestratorUserMessageIds = new Set<string>();

// ── Fable Slice 6 #2 — server-side metered-window valve state ────────────────
// The metered auto-compact target mirrors ORCHESTRATOR_METERED_AUTO_COMPACT_
// THRESHOLD in use-orchestrator-stream/shared.ts (a client module this server
// process must not import). Keep the two in sync.
const ORCHESTRATOR_METERED_AUTO_COMPACT_THRESHOLD = 15_000;
/** Warn each time the persisted thread crosses another step of this size. */
const METERED_WINDOW_VALVE_STEP_TOKENS = 60_000;
/** threadId → highest step already warned about (anti-spam). */
const meteredWindowValveWarnedStep = new Map<string, number>();

/** Approximate persisted-thread tokens from the chat-history file (chars/4). */
async function estimateThreadTokens(threadId: string): Promise<number> {
  try {
    const raw = await readFile(join(getDataDir(), 'chat-history', `${threadId}.json`), 'utf-8');
    const payload = JSON.parse(raw) as { messages?: Array<{ text?: string; content?: string }> };
    const chars = (payload.messages ?? []).reduce((sum, m) => sum + (m.text ?? m.content ?? '').length, 0);
    return Math.ceil(chars / 4);
  } catch {
    return 0;
  }
}

/** Composite key for `orchestratorSubscriptions` (`agent` is '' for codex/claude). */
function orchestratorSubKey(clientId: string, backend: OrchestratorBackendId, agent: string): string {
  return `${clientId}::${backend}::${agent}`;
}

/** Composite key for `orchestratorInflightAborts` (`agent` is '' for codex/claude). */
function orchestratorAbortKey(repoPath: string, backend: OrchestratorBackendId, agent: string, threadId: string | null): string {
  return `${repoPath}::${backend}::${agent}::${threadId ?? ''}`;
}

function resolveMsgThreadId(msg: Record<string, unknown>): string | null {
  const raw = typeof msg.threadId === 'string' ? msg.threadId.trim() : '';
  return raw.startsWith('thoughts-') ? raw : null;
}

function orchestratorRouteSessionName(sessionName: string, threadId: string | null): string {
  return threadId ? `${sessionName}::thread:${threadId}` : sessionName;
}

/**
 * Resolve the orchestrator backend id for one WS message. The explicit openclaw
 * surface passes `backend`; the default Orchestrator tab omits it and falls
 * back to the global default.
 */
function resolveMsgBackendId(msg: Record<string, unknown>): OrchestratorBackendId {
  const raw = msg.backend;
  if (isOrchestratorBackendId(raw)) return raw;
  return resolveOrchestratorBackendId();
}

/**
 * Resolve the openclaw agent id for one WS message — the openclaw surface
 * passes `agent` per request. Empty string for codex/claude (no agent
 * dimension) and for an openclaw message that omits it (the backend then falls
 * back to its default agent). Third component of the composite sub/abort keys.
 */
function resolveMsgAgentId(msg: Record<string, unknown>, backendId: OrchestratorBackendId): string {
  if (backendId !== 'openclaw') return '';
  return typeof msg.agent === 'string' && msg.agent.trim() ? msg.agent.trim() : '';
}

/** Send a raw WS message to every client subscribed to `sessionName`. */
// Last time we broadcast ANY live event for an orchestrator route session
// (turn-start busy, output, thinking, tool, done, error). Used to heal a stale
// 'busy' snapshot on (re)subscribe: a wedged child that never closed its stdout
// leaves session.status === 'busy' forever, and on every webview reload the
// snapshot replays that busy → a phantom "Working M:SS" counts up. If the
// session has been silent past the heal window, the busy is stale. (2026-06-22)
const lastOrchestratorActivityAt = new Map<string, number>();
// Mirror of the client stall watchdog (useOrchestratorStream HEAL_STALE_AFTER_MS).
const ORCH_SNAPSHOT_STALE_MS = 120_000;

// Latest active plan snapshot per route session — the mobile recovery path.
// Mobile subscribes without a `since` cursor (no seq replay), so after a
// reconnect or orchestrator-status probe the ONLY way it regains the in-flight
// turn's plan card is this point-in-time re-send. Full snapshots make
// latest-wins correct; the lossy channel semantics are unchanged (we never
// queue deltas — one snapshot, re-sent, replayed with `snapshot: true`).
const latestOrchestratorPlanBySession = new Map<string, Record<string, unknown>>();

function broadcastToOrchestratorSession(sessionName: string, rawMsg: string): void {
  lastOrchestratorActivityAt.set(sessionName, Date.now());
  // Stamp the event with a monotonic seq and buffer it so a (re)subscribing
  // client can replay what it missed (reload / reconnect / first-turn re-
  // subscribe). On a parse miss we fall back to the unstamped raw — no
  // buffering, but delivery is unchanged.
  let outMsg = rawMsg;
  try {
    const parsed = JSON.parse(rawMsg);
    if (parsed && parsed.channel === 'orchestrator') {
      // Single chokepoint for the plan cache — every emitter site (main turn,
      // rebound rehydrate, supervisor auto-queue) funnels through here.
      if (parsed.event === 'plan-update' && parsed.data) {
        latestOrchestratorPlanBySession.set(sessionName, parsed.data as Record<string, unknown>);
      } else if (
        parsed.event === 'error'
        || (parsed.event === 'status' && (parsed.data?.status === 'ready' || parsed.data?.status === 'dead'))
      ) {
        latestOrchestratorPlanBySession.delete(sessionName);
      }
      outMsg = orchestratorReplay.record(sessionName, parsed);
    }
  } catch {
    // non-JSON payload — deliver as-is
  }

  let matched = 0;
  let delivered = 0;
  for (const sub of orchestratorSubscriptions.values()) {
    if (sub.sessionName !== sessionName) continue;
    matched++;
    const c = clients.get(sub.clientId);
    if (c) { sendRaw(c, outMsg); delivered++; }
  }
  if (sessionName.includes('openclaw')) {
    console.log(`[openclaw-diag] broadcast session=${sessionName} matchedSubs=${matched} delivered=${delivered} totalSubs=${orchestratorSubscriptions.size} msg=${outMsg.slice(0, 110)}`);
  }
}

function promoteOrchestratorFallbackSubscribers(input: {
  repoPath: string;
  threadId: string | null;
  fromBackend: OrchestratorBackendId;
  toBackend: OrchestratorBackendId;
  toSessionName: string;
}): void {
  promoteOrchestratorSubscribers(orchestratorSubscriptions, input);
}

const reboundOrchestratorRecords = new Set<string>();
const reboundAssistantText = new Map<string, string>();

function handleReboundOrchestratorEvent(record: OrchestratorTurnRecord, event: OrchestratorEvent): void {
  const threadId = typeof record.threadId === 'string' && record.threadId.startsWith('thoughts-')
    ? record.threadId
    : null;
  const sessionName = orchestratorRouteSessionName(record.sessionName, threadId);
  const repoPath = record.repoPath;
  const backend = record.backend;
  const assistantMessageId = threadId
    ? record.assistantMessageId || `assistant-${record.startedAt}`
    : null;
  const assistantStartedAtMs = record.assistantStartedAtMs ?? record.startedAt;

  const persistAssistantText = (sessionId: string | null) => {
    if (!threadId || !assistantMessageId) return;
    const content = reboundAssistantText.get(record.id) ?? '';
    if (!content) return;
    try {
      const updatedThread = upsertMobileOrchestratorAssistantMessage({
        tabId: threadId,
        repoPath,
        messageId: assistantMessageId,
        content,
        backend,
        sessionId,
        model: record.model ?? null,
        timestampMs: assistantStartedAtMs,
      });
      if (updatedThread) {
        broadcast({
          channel: 'orchestrator-threads',
          event: 'upsert',
          data: { thread: updatedThread },
        });
      }
    } catch (err) {
      console.warn('[orchestrator-rehydrate] failed to persist rebound assistant text', err);
    }
  };

  if (!reboundOrchestratorRecords.has(record.id)) {
    reboundOrchestratorRecords.add(record.id);
    broadcastToOrchestratorSession(sessionName, JSON.stringify({
      channel: 'orchestrator',
      event: 'status',
      data: { status: 'busy', repoPath, threadId, backend },
    }));
  }

  let wsMsg: string | null = null;
  switch (event.type) {
    case 'text':
      reboundAssistantText.set(record.id, `${reboundAssistantText.get(record.id) ?? ''}${event.text}`);
      persistAssistantText(null);
      wsMsg = JSON.stringify({
        channel: 'orchestrator',
        event: 'output',
        data: { text: event.text, repoPath, threadId, thinking: false, backend, assistantMessageId },
      });
      break;
    case 'thinking':
      wsMsg = JSON.stringify({
        channel: 'orchestrator',
        event: 'output',
        data: { text: event.text, repoPath, threadId, thinking: true, backend, assistantMessageId },
      });
      break;
    case 'tool_use':
      wsMsg = JSON.stringify({
        channel: 'orchestrator',
        event: 'tool-use',
        data: { name: event.name, args: event.input, toolUseId: event.id ?? null, repoPath, threadId, backend, assistantMessageId },
      });
      break;
    case 'tool_result':
      wsMsg = JSON.stringify({
        channel: 'orchestrator',
        event: 'tool-result',
        data: { name: event.name, args: event.input, output: event.output, toolUseId: event.id ?? null, repoPath, threadId, backend, ...(event.isError ? { isError: true } : {}) },
      });
      break;
    case 'plan':
      wsMsg = JSON.stringify({
        channel: 'orchestrator',
        event: 'plan-update',
        data: { repoPath, threadId, turnId: assistantMessageId ?? null, explanation: event.explanation, steps: event.steps, backend },
      });
      break;
    case 'done':
      if (threadId && event.sessionId) {
        writeOrchestratorBackendSessionId(threadId, backend, event.sessionId);
      }
      persistAssistantText(event.sessionId ?? null);
      wsMsg = JSON.stringify({
        channel: 'orchestrator',
        event: 'status',
        data: { status: 'ready', repoPath, threadId, sessionId: event.sessionId, cost: event.cost, backend },
      });
      reboundAssistantText.delete(record.id);
      reboundOrchestratorRecords.delete(record.id);
      break;
    case 'error':
      persistAssistantText(null);
      wsMsg = JSON.stringify({
        channel: 'orchestrator',
        event: 'error',
        data: { error: event.error, repoPath, threadId, backend },
      });
      reboundAssistantText.delete(record.id);
      reboundOrchestratorRecords.delete(record.id);
      break;
    case 'collide_phase':
    case 'collide_proposal':
      break;
  }

  if (wsMsg) broadcastToOrchestratorSession(sessionName, wsMsg);
}

// ── Agent Supervisor auto-message queue ──

interface OrchestratorAutoMessage {
  repoPath: string;
  message: string;
  createdAt: number;
  symon?: {
    sessionId: string;
    callId: string;
    taskId: string;
  };
}

const orchestratorAutoQueue: OrchestratorAutoMessage[] = [];
const MAX_AUTO_QUEUE = 20;

function enqueueOrchestratorAutoMessage(
  repoPath: string,
  message: string,
  label: string,
  symon?: OrchestratorAutoMessage['symon'],
): void {
  if (orchestratorAutoQueue.length >= MAX_AUTO_QUEUE) {
    orchestratorAutoQueue.shift(); // Drop oldest
    console.warn('[supervisor] Auto-message queue overflow — dropped oldest');
  }
  orchestratorAutoQueue.push({ repoPath, message, createdAt: Date.now(), ...(symon ? { symon } : {}) });
  console.log(`[supervisor] Queued ${label} for ${repoPath} (${orchestratorAutoQueue.length} in queue)`);
  void drainOrchestratorAutoQueue();
}

function queueOrchestratorEscalation(repoPath: string, message: string): void {
  // Supervisor escalations spawn fresh orchestrator turns into the user's
  // chat — that's how codex agent narrative + bash runs end up bleeding into
  // the orchestrator transcript. Default OFF: supervisor failures surface via
  // lane status + activity feed instead, leaving the chat clean.
  // Set O8_SUPERVISOR_AUTO_ESCALATE=1 (or flip Settings → Dispatch &
  // Supervision → Auto-escalate) to restore the old auto-investigation.
  if (!resolveSupervisorAutoEscalateSync()) {
    console.log(`[supervisor] Escalation suppressed (auto-escalate disabled): ${repoPath} — ${message.slice(0, 80)}`);
    return;
  }
  enqueueOrchestratorAutoMessage(repoPath, message, 'escalation');
}

// #1481 — review-ready self-continuation. When a MISSION lane lands at
// review, the fleet must not park until the operator re-prompts: queue one
// bounded orchestrator turn ("review + merge per the standing instruction").
// Gated on its own operator setting (reviewContinuation, default ON —
// distinct from the noisy failure-investigation escalations above), scoped to
// packet-bound lanes, and deduped per lane so a flapping transition can't
// spam turns. The operator prompt arms the loop; it is not its clock.
const REVIEW_CONTINUATION_DEDUPE_MS = 10 * 60 * 1000;
const reviewContinuationQueuedAt = new Map<string, number>();

function queueReviewContinuation(lane: { id: string; label: string; repoPath: string; packetId?: string | null; branch?: string | null }): void {
  if (!lane.packetId) return; // ad-hoc lanes have no mission contract to continue
  if (!resolveReviewContinuationSync()) return;
  const last = reviewContinuationQueuedAt.get(lane.id);
  const now = Date.now();
  if (last && now - last < REVIEW_CONTINUATION_DEDUPE_MS) return;
  reviewContinuationQueuedAt.set(lane.id, now);
  if (reviewContinuationQueuedAt.size > 200) {
    for (const [key, ts] of reviewContinuationQueuedAt) {
      if (now - ts > REVIEW_CONTINUATION_DEDUPE_MS) reviewContinuationQueuedAt.delete(key);
    }
  }
  enqueueOrchestratorAutoMessage(
    lane.repoPath,
    [
      `[FLEET] Lane "${lane.label}" (${lane.id}, packet ${lane.packetId}) reached review-ready.`,
      'Per the mission\'s standing instruction, continue the loop for THIS packet now:',
      `1. o8_packet_diff / o8_merge_preview for packet ${lane.packetId}`,
      '2. If the diff is clean, submit_review + approve_and_merge (rebase-before-merge discipline applies).',
      '3. If it is not clean, record findings via submit_review(approved:false) or steer the worker — do not merge.',
      'This is a bounded self-continuation turn (one per lane review transition; Settings → Dispatch & Supervision → Review continuation).',
    ].join('\n'),
    'review continuation',
  );
}

async function drainOrchestratorAutoQueue(): Promise<void> {
  if (orchestratorAutoQueue.length === 0) return;

  const next = orchestratorAutoQueue[0];
  const backend = getActiveOrchestratorBackend();
  let session = backend.peekSession(next.repoPath);
  if (!session || session.status === 'dead') {
    session = backend.ensureSession(next.repoPath);
  }
  if (session.status === 'busy') return; // Wait for current message to finish

  // Dequeue
  orchestratorAutoQueue.shift();
  console.log(`[supervisor] Draining auto-message for ${next.repoPath}`);

  let symonTerminalSent = false;
  const finishSymonDelegate = (status: 'done' | 'failed') => {
    if (!next.symon || symonTerminalSent) return;
    symonTerminalSent = true;
    const owner = currentSymonOwner(next.symon.sessionId);
    if (!owner) return;
    pushSymonActionComplete(owner.route.clientId, {
      sessionId: next.symon.sessionId,
      callId: next.symon.callId,
      tool: 'o8_delegate',
      status,
      taskId: next.symon.taskId,
      ts: new Date().toISOString(),
    });
  };

  try {
    await backend.sendTurn(next.repoPath, next.message, (event) => {
      const sessionName = session!.sessionName;
      let wsMsg: string | null = null;
      switch (event.type) {
        case 'text':
          wsMsg = JSON.stringify({ channel: 'orchestrator', event: 'output', data: { text: event.text, repoPath: next.repoPath, thinking: false, backend: backend.id } });
          break;
        case 'thinking':
          wsMsg = JSON.stringify({ channel: 'orchestrator', event: 'output', data: { text: event.text, repoPath: next.repoPath, thinking: true, backend: backend.id } });
          break;
        case 'tool_use':
          wsMsg = JSON.stringify({
            channel: 'orchestrator',
            event: 'tool-use',
            data: { name: event.name, args: event.input, toolUseId: event.id ?? null, repoPath: next.repoPath, backend: backend.id },
          });
          break;
        case 'tool_result':
          wsMsg = JSON.stringify({
            channel: 'orchestrator',
            event: 'tool-result',
            data: {
              name: event.name,
              args: event.input,
              output: event.output,
              toolUseId: event.id ?? null,
              repoPath: next.repoPath,
              backend: backend.id,
              ...(event.isError ? { isError: true } : {}),
            },
          });
          break;
        case 'plan':
          wsMsg = JSON.stringify({
            channel: 'orchestrator',
            event: 'plan-update',
            data: { repoPath: next.repoPath, threadId: null, turnId: null, explanation: event.explanation, steps: event.steps, backend: backend.id },
          });
          break;
        case 'done':
          wsMsg = JSON.stringify({ channel: 'orchestrator', event: 'status', data: { status: 'ready', repoPath: next.repoPath, backend: backend.id } });
          finishSymonDelegate('done');
          break;
        case 'error':
          wsMsg = JSON.stringify({ channel: 'orchestrator', event: 'error', data: { error: event.error, repoPath: next.repoPath, backend: backend.id } });
          finishSymonDelegate('failed');
          break;
      }
      if (wsMsg) broadcastToOrchestratorSession(sessionName, wsMsg);
    });
  } catch (err) {
    console.error('[supervisor] Auto-message failed:', err);
    finishSymonDelegate('failed');
  }

  // Continue draining
  void drainOrchestratorAutoQueue();
}

// Orchestrator now uses structured JSON output (stream-json) instead of PTY.
// See orchestrator-session.ts for the new approach.

// ── Sync-FS note (#1498 sweep) ──────────────────────────────────────────────
// The tmux helpers below still use execFileSync (has-session / new-session /
// capture-pane / kill-session) and a couple of existsSync probes. These are
// intentionally NOT converted to async in this sweep: they are wired into a
// synchronous terminal create/attach call chain (materializePendingDashSession
// → createDashTmuxSessionSync → spawn*Pty → registerTerminalAttachment) and
// threading async through it piecemeal would (a) be invasive and (b) be redone
// by the terminal-host extraction, which moves ALL PTY/tmux work off this event
// loop into a forked child process (the real structural fix). The pure-FS hot
// paths that touch the loop per-message/per-poll — estimateThreadTokens,
// handleTerminalImage, getReviewWatchTargets/listRepoPaths — ARE async now.
// Remaining sync FS is startup/module-init only (git-watcher setup, port
// reclaim, bootstrap worktree prune) or the deferred terminal chain above.
function spawnDashShellPty(
  sessionName: string,
  cols: number,
  rows: number,
  requestedCwd?: string,
) {
  if (!terminalHost) {
    throw new Error('node-pty not available');
  }

  const shell = resolvePreferredShell();
  const env = sanitizePtyEnv();
  env.CORTEX_TERMINAL_SESSION_NAME = sessionName;
  const cwd = (requestedCwd && existsSync(requestedCwd) ? requestedCwd : undefined)
    ?? process.env.HOME ?? homedir() ?? '/tmp';

  console.log(`[ws-server] Spawning dashboard PTY shell: ${shell} -l (${sessionName})`);
  return terminalHost.spawn({
    file: shell,
    args: ['-l'],
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env,
  });
}

// #6 persistent terminals — opt-in (default OFF). Inlined to avoid threading an
// import through this 5000-line module; mirrors persistentTerminalsEnabled() in
// @/lib/terminal/tmux.ts (which carries the test + doc).
function dashPersistentTerminalsEnabled(): boolean {
  const raw = process.env.O8_PERSISTENT_TERMINALS?.trim().toLowerCase();
  if (raw === undefined || raw === '') return true;
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}

/**
 * #6 persistent terminals — create (or confirm) a tmux session for an interactive
 * dash terminal so the shell survives a ws-server restart / app crash. Synchronous
 * (a terminal create is a deliberate user action; the brief block is fine), gated
 * behind O8_PERSISTENT_TERMINALS, and returns false on ANY failure so the caller
 * falls back to the legacy plain-shell PTY (no regression on no-tmux machines).
 * Keeps the cortex-dash-* name so all existing prefix logic survives.
 */
function createDashTmuxSessionSync(
  sessionName: string,
  cols: number,
  rows: number,
  requestedCwd?: string,
): boolean {
  if (!dashPersistentTerminalsEnabled()) return false;
  let tmuxBin: string;
  try {
    tmuxBin = resolveTmuxBinary();
  } catch {
    return false;
  }
  const shell = resolvePreferredShell();
  const env = sanitizePtyEnv();
  env.CORTEX_TERMINAL_SESSION_NAME = sessionName;
  const cwd = (requestedCwd && existsSync(requestedCwd) ? requestedCwd : undefined)
    ?? process.env.HOME ?? homedir() ?? '/tmp';
  try {
    // Idempotent: an existing session (re-attach after restart) is reused as-is.
    try {
      execFileSync(tmuxBin, ['has-session', '-t', sessionName], { timeout: 3000, stdio: 'ignore' });
      return true;
    } catch { /* not present — create it below */ }
    execFileSync(tmuxBin, [
      'new-session', '-d', '-s', sessionName,
      '-x', String(cols), '-y', String(rows),
      shell, '-l',
    ], { cwd, timeout: 8000, env: env as NodeJS.ProcessEnv });
    // Large scrollback so Stage-3 capture-pane recovers real history; NO
    // remain-on-exit so the user's `exit` ends the session (interactive semantics).
    execFileSync(tmuxBin, ['set-option', '-t', sessionName, 'history-limit', '50000'], { timeout: 3000, stdio: 'ignore' });
    // Persistence must be INVISIBLE — hide the tmux status bar so a backed
    // terminal looks byte-identical to a plain shell (no green chrome row).
    execFileSync(tmuxBin, ['set-option', '-t', sessionName, 'status', 'off'], { timeout: 3000, stdio: 'ignore' });
    console.log(`[ws-server] Created persistent dash tmux session: ${sessionName}`);
    return true;
  } catch (err) {
    console.warn(`[ws-server] dash tmux create failed for ${sessionName}, falling back to plain shell: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// #6 persistent terminals — orphan dash-session GC. Under persistence, dash
// terminals live in detached tmux sessions that survive a restart/crash; the
// flip side is a leak — a session whose tab was closed (or whose app crashed
// before cleanup) has no owner. This bounded sweep reaps `cortex-dash-*`
// sessions referenced by no persisted tab and no live client. Cadence mirrors
// the managed-runs reconcile; the kill decision is the pure dash-gc policy.
const DASH_GC_INTERVAL_MS = 30 * 60 * 1000;
const DASH_GC_MIN_AGE_MS = 5 * 60 * 1000;
const DASH_GC_MAX_SESSIONS = 64;
let dashGcTimer: ReturnType<typeof setInterval> | null = null;

/** One `tmux list-sessions` → live `cortex-dash-*` sessions with creation age. */
function listDashTmuxSessionsWithAge(): DashSessionInfo[] {
  try {
    const out = execFileSync(
      resolveTmuxBinary(),
      ['list-sessions', '-F', '#{session_name} #{session_created}'],
      { timeout: 4000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], env: sanitizePtyEnv() as NodeJS.ProcessEnv },
    );
    const rows: DashSessionInfo[] = [];
    for (const line of out.split('\n')) {
      const [name, created] = line.trim().split(/\s+/);
      if (!name || !name.startsWith('cortex-dash-')) continue;
      const sec = Number(created);
      rows.push({ name, createdMs: Number.isFinite(sec) && sec > 0 ? sec * 1000 : 0 });
    }
    return rows;
  } catch {
    return [];
  }
}

/**
 * #6 persistent terminals — capture a dash session's scrollback history so a
 * re-attach after a restart/crash restores what scrolled off-screen (a bare
 * `tmux attach` only repaints the visible viewport). `-S -` = from the start of
 * history, `-e` = keep colour/style escapes. Bounded to the ring size; empty on
 * any failure. Caller trims the trailing visible rows (the attach repaints them).
 */
function captureTmuxPane(sessionName: string): string {
  try {
    return execFileSync(
      resolveTmuxBinary(),
      ['capture-pane', '-p', '-e', '-S', '-', '-t', sessionName],
      {
        timeout: 4000,
        encoding: 'utf-8',
        maxBuffer: TERMINAL_SCROLLBACK_MAX_BYTES,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: sanitizePtyEnv() as NodeJS.ProcessEnv,
      },
    );
  } catch {
    return '';
  }
}

function reapOrphanDashSessions() {
  if (!dashPersistentTerminalsEnabled()) return;
  const sessions = listDashTmuxSessionsWithAge();
  if (sessions.length === 0) return;

  // Durable reference set FIRST — never reap on a failed read of persisted tabs
  // (after a crash the in-memory map is empty; persisted tabs are the only
  // owner record, so a read failure must abort the sweep, not reap survivors).
  let referenced: Set<string>;
  try {
    referenced = collectPersistedTmuxSessions();
  } catch {
    return;
  }
  // A session with live clients is referenced too — covers the brief
  // create→persist window before the tab file is flushed.
  for (const [name, att] of terminalAttachments) {
    if (att.clientIds.size > 0) referenced.add(name);
  }

  const toKill = selectOrphanDashSessions(sessions, referenced, {
    nowMs: Date.now(),
    minAgeMs: DASH_GC_MIN_AGE_MS,
    maxSessions: DASH_GC_MAX_SESSIONS,
  });
  if (toKill.length === 0) return;

  const tmuxBin = resolveTmuxBinary();
  for (const name of toKill) {
    // Tear down any warm-but-detached local PTY view first (0-client survivors
    // from the reaper's persistence path), then kill the tmux session.
    const att = terminalAttachments.get(name);
    if (att) {
      if (att.orphanTimer) clearTimeout(att.orphanTimer);
      if (att.batchTimer) clearTimeout(att.batchTimer);
      try { att.ptyProcess.kill(); } catch { /* already gone */ }
      terminalAttachments.delete(name);
    }
    try {
      execFileSync(tmuxBin, ['kill-session', '-t', name], { timeout: 3000, stdio: 'ignore', env: sanitizePtyEnv() as NodeJS.ProcessEnv });
    } catch { /* already gone */ }
  }
  console.log(`[ws-server] [persistent-terminals] GC reaped ${toKill.length} orphan dash tmux session(s)`);
}

function startDashSessionGc() {
  if (dashGcTimer) return;
  dashGcTimer = setInterval(() => {
    try { reapOrphanDashSessions(); } catch { /* best effort */ }
  }, DASH_GC_INTERVAL_MS);
  dashGcTimer.unref?.();
  console.log('[ws-server] [persistent-terminals] orphan dash-session GC started');
}

function stopDashSessionGc() {
  if (dashGcTimer) {
    clearInterval(dashGcTimer);
    dashGcTimer = null;
  }
}

function spawnManagedCommandPty(
  sessionName: string,
  shellCommand: string,
  cwd: string,
  cols: number,
  rows: number,
  envOverrides?: Record<string, string>,
) {
  if (!terminalHost) {
    throw new Error('node-pty not available');
  }

  const shell = resolvePreferredShell();
  const env = {
    ...sanitizePtyEnv(),
    ...(envOverrides ?? {}),
    CORTEX_TERMINAL_SESSION_NAME: sessionName,
  };

  console.log(`[ws-server] Spawning managed PTY session: ${shell} -lc <command> (${sessionName})`);
  return terminalHost.spawn({
    file: shell,
    args: ['-l', '-c', shellCommand],
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env,
  });
}

function trimScrollback(att: TerminalAttachment) {
  while (att.scrollbackBytes > TERMINAL_SCROLLBACK_MAX_BYTES && att.scrollbackChunks.length > 0) {
    const removed = att.scrollbackChunks.shift() ?? '';
    att.scrollbackBytes -= Buffer.byteLength(removed, 'utf-8');
  }
}

function appendScrollback(att: TerminalAttachment, data: string) {
  if (!data) return;
  att.scrollbackChunks.push(data);
  att.scrollbackBytes += Buffer.byteLength(data, 'utf-8');
  trimScrollback(att);
}

function sendTerminalScrollback(client: ClientState, attachment: TerminalAttachment) {
  if (attachment.scrollbackChunks.length === 0) return;
  const scrollback = attachment.scrollbackChunks.join('');
  if (!scrollback) return;
  const encoded = Buffer.from(scrollback, 'utf-8').toString('base64');
  sendRaw(client, JSON.stringify({
    channel: 'terminal',
    event: 'data',
    data: { sessionName: attachment.sessionName, data: encoded },
  }));
}

function registerTerminalAttachment(attachment: TerminalAttachment) {
  const { sessionName, ptyProcess } = attachment;

  ptyProcess.onData((data: string) => {
    const att = terminalAttachments.get(sessionName);
    if (!att) return;

    att.lastOutputAt = Date.now();
    appendScrollback(att, data);
    att.batchBuffer += data;

    if (!att.batchTimer) {
      att.batchTimer = setTimeout(() => {
        const buffered = att.batchBuffer;
        att.batchBuffer = '';
        att.batchTimer = null;

        if (!buffered || att.clientIds.size === 0) return;

        const encoded = Buffer.from(buffered, 'utf-8').toString('base64');
        const msg = JSON.stringify({
          channel: 'terminal',
          event: 'data',
          data: { sessionName, data: encoded },
        });

        for (const cid of att.clientIds) {
          const c = clients.get(cid);
          if (c) sendRaw(c, msg);
        }
      }, TERMINAL_BATCH_MS);
    }
  });

  ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
    console.log(`[ws-server] Terminal PTY exited for ${sessionName} (code ${exitCode})`);
    const att = terminalAttachments.get(sessionName);
    if (!att) return;

    if (att.batchTimer) clearTimeout(att.batchTimer);
    if (att.orphanTimer) clearTimeout(att.orphanTimer);

    if (att.batchBuffer) {
      appendScrollback(att, att.batchBuffer);
      const encoded = Buffer.from(att.batchBuffer, 'utf-8').toString('base64');
      const flushMsg = JSON.stringify({
        channel: 'terminal', event: 'data', data: { sessionName, data: encoded },
      });
      for (const cid of att.clientIds) {
        const c = clients.get(cid);
        if (c) sendRaw(c, flushMsg);
      }
    }

    const exitMsg = JSON.stringify({
      channel: 'terminal', event: 'exited', data: { sessionName, exitCode },
    });
    for (const cid of att.clientIds) {
      const c = clients.get(cid);
      if (c) {
        sendRaw(c, exitMsg);
        c.terminalSessions.delete(sessionName);
      }
    }

    terminalAttachments.delete(sessionName);

    if (!isDashTerminalSession(sessionName)) {
      broadcastLifecycle(sessionName, exitCode === 0 ? 'completed' : 'failed', exitCode);
    }
  });
}

function spawnTmuxAttachPty(
  sessionName: string,
  cols: number,
  rows: number,
) {
  if (!terminalHost) {
    throw new Error('node-pty not available');
  }

  const tmuxBin = resolveTmuxBinary();
  const env = sanitizePtyEnv();
  const cwd = process.env.HOME ?? homedir() ?? '/tmp';

  try {
    console.log(`[ws-server] Spawning terminal directly: ${tmuxBin} attach-session -t ${sessionName}`);
    return terminalHost.spawn({
      file: tmuxBin,
      args: ['attach-session', '-t', sessionName],
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
    });
  } catch (directError) {
    const shell = resolvePreferredShell();
    const shellCmd = `exec "${tmuxBin}" attach-session -t ${sessionName}`;
    console.warn(`[ws-server] Direct tmux PTY spawn failed, falling back to shell wrapper: ${directError instanceof Error ? directError.message : String(directError)}`);
    console.log(`[ws-server] Spawning terminal via shell: ${shellCmd}`);
    return terminalHost.spawn({
      file: shell,
      args: ['-l', '-c', shellCmd],
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
    });
  }
}

const chatListeners = new Set<(delta: ChatDelta) => void>();

// #1484 — busy-not-dead. A saturated-but-alive next-server loop made bridge
// fetches time out, the exponential backoff latched 'down', and the client
// parked on "Realtime bridge reconnecting… backing off" for up to 60s while
// the fleet was fine. Before declaring any bridge channel down, probe the
// cheapest endpoint (identity: no DB, no recompute) with a generous deadline.
// Alive → reset the ramp (retries stay on the initial cadence, the channel
// stays officially up); truly dead → the down transition proceeds as before.
// Cost: one probe per DOWN transition attempt, i.e. at most once per 5
// consecutive failures per channel.
async function nextServerAliveDespiteBackpressure(): Promise<boolean> {
  try {
    const res = await fetch(buildNextUrl('/api/setup/identity'), {
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Adversarial F15 — the probe hits a DIFFERENT (cheapest) endpoint than the
// channel that is failing, so a channel whose OWN route is genuinely broken
// while the server is alive would be masked forever: every down transition
// overridden, full-cadence hot retries, no operator signal. Cap consecutive
// overrides per channel; a real channel success resets the count.
const BRIDGE_PROBE_OVERRIDE_CAP = 5;
const bridgeProbeOverrides = new Map<string, number>();

function recordBridgeChannelSuccess(channel: string): void {
  bridgeProbeOverrides.delete(channel);
}

async function shouldOverrideBridgeDown(channel: string): Promise<boolean> {
  const overrides = bridgeProbeOverrides.get(channel) ?? 0;
  if (overrides >= BRIDGE_PROBE_OVERRIDE_CAP) {
    console.warn(`[ws-server] ${channel}: server alive but the channel itself failed ${overrides}x in a row — letting it latch down.`);
    return false;
  }
  if (!(await nextServerAliveDespiteBackpressure())) return false;
  bridgeProbeOverrides.set(channel, overrides + 1);
  return true;
}

// ── Sync helpers ──

async function fetchSync(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetchWithRetry(buildNextUrl('/api/mobile/sync'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json() as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractText(delta: ChatDelta): string {
  if (!delta.message?.content) return delta.partialText ?? '';
  return delta.message.content
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text ?? '')
    .join('');
}


/** Flush any queued durable messages once backpressure clears. */
function flushBackpressureQueue(client: ClientState) {
  if (client.ws.readyState !== WebSocket.OPEN) {
    client.backpressureQueue.length = 0;
    stopFlushTimer(client);
    return;
  }
  if (client.ws.bufferedAmount > BACKPRESSURE_LIMIT) return; // still pressured

  // Drain the queue
  while (client.backpressureQueue.length > 0) {
    if (client.ws.bufferedAmount > BACKPRESSURE_LIMIT) return; // pause mid-flush
    const queued = client.backpressureQueue.shift()!;
    client.ws.send(queued);
  }
  stopFlushTimer(client);
}

function startFlushTimer(client: ClientState) {
  if (client.flushTimer) return;
  client.flushTimer = setInterval(() => flushBackpressureQueue(client), BACKPRESSURE_FLUSH_MS);
}

function stopFlushTimer(client: ClientState) {
  if (client.flushTimer) {
    clearInterval(client.flushTimer);
    client.flushTimer = null;
  }
}

// ── Mobile E2EE channel (#5) ──
// Wrap/unwrap the WS frame payload for handshaken remote clients. Loopback +
// legacy clients have no `e2ee` state, so wireForClient is a pass-through and
// the path is byte-identical to before.

const E2EE_HANDSHAKE_TIMEOUT_MS = 2500; // no e2ee-init by now → plaintext fallback

/** Encrypt a plaintext frame for an ENCRYPTED client; pass-through otherwise. */
function wireForClient(client: ClientState, plaintext: string): string {
  if (client.e2ee?.state === 'encrypted' && client.e2ee.sessionKey) {
    return JSON.stringify(encryptFrame(plaintext, client.e2ee.sessionKey));
  }
  return plaintext;
}

/** Initial per-client state (inbox + orchestrator snapshot). Deferred past the
 *  handshake for E2EE clients so it never goes out in plaintext. */
function sendInitialClientState(client: ClientState): void {
  void syncClientInbox(client);
  sendOrchestratorThreadSnapshot(client);
}

/** Offer E2EE to a remote per-device-token client: send a signed hello, arm the
 *  plaintext-fallback timer. Initial state is withheld until the channel is up. */
function initiateE2eeHandshake(client: ClientState, device: MobileDevice): void {
  try {
    const { handshake, hello } = startServerHandshake(getServerIdentity(), device.identityPublicKey);
    // Send hello while the connection is still "plaintext" (e2ee unset) so the
    // awaiting-init suppression in send/sendRaw doesn't block it; THEN enter the
    // handshake window. hello is plaintext (it establishes the key) but signed.
    send(client, { channel: 'system', event: 'e2ee-hello', data: hello });
    client.e2ee = { state: 'awaiting-init', handshake };
    client.e2ee.helloTimer = setTimeout(() => {
      // Old/no-RNG client never answered — fall back to plaintext (negotiated).
      if (client.e2ee?.state === 'awaiting-init') {
        console.log(`[mobile-e2ee] ${client.id} did not complete handshake — plaintext fallback`);
        client.e2ee = undefined;
        sendInitialClientState(client);
      }
    }, E2EE_HANDSHAKE_TIMEOUT_MS);
  } catch (error) {
    console.warn(`[mobile-e2ee] handshake init failed for ${client.id}: ${error instanceof Error ? error.message : String(error)}`);
    client.e2ee = undefined;
    sendInitialClientState(client);
  }
}

/** Handle the client's e2ee-init: verify + derive the session key, then deliver
 *  an encrypted e2ee-ready + the (now encrypted) initial state. */
function handleE2eeInit(client: ClientState, msg: Record<string, unknown>): void {
  const e2ee = client.e2ee;
  if (!e2ee || e2ee.state !== 'awaiting-init' || !e2ee.handshake) return;
  if (e2ee.helloTimer) { clearTimeout(e2ee.helloTimer); e2ee.helloTimer = undefined; }
  const result = completeServerHandshake(e2ee.handshake, {
    clientEphPub: msg.clientEphPub,
    clientNonce: msg.clientNonce,
    clientSig: msg.clientSig,
  });
  if ('error' in result) {
    console.warn(`[mobile-e2ee] ${client.id} handshake rejected: ${result.error}`);
    try { client.ws.close(4403, 'e2ee handshake failed'); } catch { /* already gone */ }
    return;
  }
  e2ee.sessionKey = result.sessionKey;
  e2ee.handshake = undefined;
  e2ee.state = 'encrypted';
  // First encrypted frame — the client decrypting it confirms key agreement.
  send(client, { channel: 'system', event: 'e2ee-ready' });
  sendInitialClientState(client);
  console.log(`[mobile-e2ee] ${client.id} channel encrypted`);
}

function send(client: ClientState, msg: Record<string, unknown>) {
  if (client.ws.readyState !== WebSocket.OPEN) return;
  // #5 — during the E2EE handshake window, suppress app frames so nothing leaks
  // in plaintext before the key is agreed. The post-ready full sync + durable-
  // channel safety-net polling recover anything dropped in this sub-second gap.
  if (client.e2ee?.state === 'awaiting-init') return;
  const plaintext = JSON.stringify(msg);
  const json = wireForClient(client, plaintext);
  if (client.ws.bufferedAmount > BACKPRESSURE_LIMIT) {
    if (isLossyMessage(plaintext)) return; // safe to drop
    // Queue durable message for later delivery
    if (client.backpressureQueue.length >= BACKPRESSURE_QUEUE_LIMIT) {
      client.backpressureQueue.shift(); // drop oldest if queue is full
    }
    client.backpressureQueue.push(json);
    startFlushTimer(client);
    return;
  }
  // Flush any pending queue first (maintain ordering)
  if (client.backpressureQueue.length > 0) {
    flushBackpressureQueue(client);
    if (client.backpressureQueue.length > 0) {
      // Flush paused mid-drain (buffer re-pressured) — sending now would jump
      // ahead of queued durable messages and reorder them.
      if (isLossyMessage(plaintext)) return;
      if (client.backpressureQueue.length >= BACKPRESSURE_QUEUE_LIMIT) {
        client.backpressureQueue.shift();
      }
      client.backpressureQueue.push(json);
      startFlushTimer(client);
      return;
    }
  }
  client.ws.send(json);
}

function sendRaw(client: ClientState, preStringified: string) {
  if (client.ws.readyState !== WebSocket.OPEN) return;
  if (client.e2ee?.state === 'awaiting-init') return; // #5 handshake window — suppress
  // Lossy/durable is decided from the PLAINTEXT (the channel); the wire is the
  // per-client encrypted frame for an E2EE client, or the plaintext otherwise.
  const wire = wireForClient(client, preStringified);
  if (client.ws.bufferedAmount > BACKPRESSURE_LIMIT) {
    if (isLossyMessage(preStringified)) return; // safe to drop
    if (client.backpressureQueue.length >= BACKPRESSURE_QUEUE_LIMIT) {
      client.backpressureQueue.shift();
    }
    client.backpressureQueue.push(wire);
    startFlushTimer(client);
    return;
  }
  if (client.backpressureQueue.length > 0) {
    flushBackpressureQueue(client);
    if (client.backpressureQueue.length > 0) {
      if (isLossyMessage(preStringified)) return;
      if (client.backpressureQueue.length >= BACKPRESSURE_QUEUE_LIMIT) {
        client.backpressureQueue.shift();
      }
      client.backpressureQueue.push(wire);
      startFlushTimer(client);
      return;
    }
  }
  client.ws.send(wire);
}

function broadcast(msg: Record<string, unknown>, filter?: (c: ClientState) => boolean) {
  const json = JSON.stringify(msg);
  for (const client of clients.values()) {
    if (filter && !filter(client)) continue;
    sendRaw(client, json);
  }
}

function sendOrchestratorThreadSnapshot(client: ClientState) {
  try {
    send(client, {
      channel: 'orchestrator-threads',
      event: 'snapshot',
      data: { threads: listMobileOrchestratorThreads({ backend: null }) },
    });
  } catch {
    // Snapshot is a live convenience; HTTP thread fetch remains the fallback.
  }
}

function orchestratorThreadFingerprint(thread: MobileOrchestratorThread): string {
  return JSON.stringify({
    id: thread.id,
    title: thread.title,
    lastMessageAt: thread.lastMessageAt,
    runtime: thread.runtime,
    status: thread.status,
    messageCount: thread.messageCount,
    repoPath: thread.repoPath,
    repoName: thread.repoName,
    repoBranch: thread.repoBranch,
    githubOwner: thread.githubOwner,
    githubRepo: thread.githubRepo,
    backend: thread.backend,
    agent: thread.agent,
    pinned: thread.pinned === true,
  });
}

let lastOrchestratorThreadFingerprints = new Map<string, string>();
let lastOrchestratorRevealCursor = new Date(Date.now() - 3000).toISOString();
let lastOrchestratorThreadHistoryStatToken: string | null = null;

async function pushOrchestratorThreadChanges() {
  if (clients.size === 0) return;
  try {
    const statToken = await mobileOrchestratorThreadHistoryStatTokenAsync();
    if (lastOrchestratorThreadHistoryStatToken === statToken) return;

    const threads = listMobileOrchestratorThreads({ backend: null });
    const nextFingerprints = new Map<string, string>();
    for (const thread of threads) {
      const fingerprint = orchestratorThreadFingerprint(thread);
      nextFingerprints.set(thread.id, fingerprint);
      const previous = lastOrchestratorThreadFingerprints.get(thread.id);
      if (previous === fingerprint) continue;
      broadcast({
        channel: 'orchestrator-threads',
        event: previous ? 'updated' : 'created',
        data: { thread },
      });
    }
    lastOrchestratorThreadFingerprints = nextFingerprints;

    const revealRequests = listMobileOrchestratorRevealRequests(lastOrchestratorRevealCursor);
    for (const request of revealRequests) {
      if (Date.parse(request.requestedAt) > Date.parse(lastOrchestratorRevealCursor)) {
        lastOrchestratorRevealCursor = request.requestedAt;
      }
      broadcast({
        channel: 'orchestrator-threads',
        event: 'reveal',
        data: request,
      });
    }
    lastOrchestratorThreadHistoryStatToken = statToken;
  } catch (error) {
    console.warn('[ws-server] orchestrator thread sync failed:', error instanceof Error ? error.message : String(error));
  }
}

function packetTailChannel(packetId: string) {
  return `packet-tail:${packetId}`;
}

function sendPacketTailEvent(client: ClientState, event: PacketTailEvent) {
  send(client, {
    channel: packetTailChannel(event.packetId),
    type: 'lane-event',
    ...event,
  });
}

function broadcastPacketTailEvent(event: PacketTailEvent) {
  broadcast({
    channel: packetTailChannel(event.packetId),
    type: 'lane-event',
    ...event,
  }, (client) => client.packetTailSubscriptions.has(event.packetId));
}

function isPacketTailEvent(value: unknown): value is PacketTailEvent {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.schema === 'o8/lane.event/v1'
    && typeof record.packetId === 'string'
    && typeof record.laneId === 'string'
    && typeof record.verb === 'string'
    && typeof record.timestamp === 'string'
    && typeof record.timestampMs === 'number';
}

function parsePacketTailSince(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}

async function sendPacketTailHistory(client: ClientState, packetId: string, since?: number) {
  try {
    const result = await getPacketTailBatch({
      packetId,
      since,
      timeoutMs: 0,
    });
    for (const event of result.events) {
      sendPacketTailEvent(client, event);
    }
  } catch (error) {
    send(client, {
      channel: packetTailChannel(packetId),
      type: 'error',
      error: error instanceof Error ? error.message : 'Failed to read packet tail history.',
    });
  }
}

// ── Realtime envelope log / replay ──

const REALTIME_LOG_LIMIT = 400;
const BROWSER_DISCOVERY_INTERVAL_MS = 15_000;
const ATTACHED_BROWSER_REFRESH_MS = 2_000;

let realtimeSeq = 0;
const realtimeLog: RealtimeEventEnvelope[] = [];
let runtimeRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let runtimeRefreshFreshRequested = false;
let mobileRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let mobileRefreshFreshRequested = false;
const mobileInboxBridgeBackoff = createRealtimeBridgeBackoffState();
const globalSnapshotBridgeBackoff = createRealtimeBridgeBackoffState();
const headlessTickBridgeBackoff = createRealtimeBridgeBackoffState();
let headlessTickBridgeInFlight = false;
// Single-flight guards. The snapshot/inbox fetches take 3-5s in dev; the debounce
// schedulers null their timer the instant they fire (BEFORE the fetch resolves),
// so overlapping callers (client mutation/refresh POSTs) used to launch concurrent
// fetches that piled up into a timeout spiral. These cap each channel at one
// in-flight fetch plus one trailing re-fire — trigger-agnostic, covers every caller.
let globalSnapshotInFlight = false;
let globalSnapshotRerequest: { fresh: boolean; reason?: string } | null = null;
let mobileSnapshotInFlight = false;
let mobileSnapshotRerequest: { fresh: boolean } | null = null;
const sessionHistoryTimers = new Map<string, ReturnType<typeof setTimeout>>();
let browserDiscoveryTimer: ReturnType<typeof setInterval> | null = null;
let attachedBrowserRefreshTimer: ReturnType<typeof setInterval> | null = null;
let stopHeadlessLoop: (() => void) | null = null;
let stopHealBotLoop: (() => void) | null = null;
let stopSilentExitDetectorLoop: (() => void) | null = null;
let stopDocWatcherLoop: (() => void) | null = null;

const lastRealtimeFingerprint = {
  runtime: '',
  review: '',
  browser: '',
  mobileInbox: '',
  history: new Map<string, string>(),
};
// #1650: review/browser snapshots on the global stream coalesce to ≤1Hz.
// Genuine churn (per-action browser lastActionAt, mid-rebase review states)
// emits latest-wins via a trailing refresh instead of at event rate — every
// mobile client subscribes to this stream and parses every byte.
const GLOBAL_SNAPSHOT_MIN_EMIT_MS = 1000;
const lastGlobalSnapshotEmitAt = { review: 0, browser: 0 };
let mobileInboxRevision = 0;
let lastMobileInboxSnapshot: MobileInboxSnapshot | null = null;
let mobileInboxDeltasSinceCheckpoint = 0;
const MOBILE_INBOX_CHECKPOINT_INTERVAL = 20;

async function getRegisteredMobileInboxCheckpoint(): Promise<{
  inbox: MobileInboxSnapshot;
  revision: number;
}> {
  if (lastMobileInboxSnapshot) {
    return { inbox: lastMobileInboxSnapshot, revision: mobileInboxRevision };
  }
  const inbox = await getMobileInboxSnapshot();
  lastMobileInboxSnapshot = inbox;
  mobileInboxRevision = Math.max(1, mobileInboxRevision);
  lastRealtimeFingerprint.mobileInbox = fingerprintInboxSnapshot(inbox);
  return { inbox, revision: mobileInboxRevision };
}

function currentIsoTime() {
  return new Date().toISOString();
}

let realtimeBridgeMutationSeq = 0;

function publishRealtimeBridgeConnectionState(
  bridge: 'mobile-inbox' | 'headless-tick' | 'global-snapshot',
  state: 'down' | 'up',
  reason?: string,
) {
  const mutation: RealtimeMutationRecord = {
    mutationId: `realtime-bridge-${bridge}-${Date.now()}-${realtimeBridgeMutationSeq += 1}`,
    source: 'server',
    action: 'realtime-bridge-connection',
    status: state === 'down' ? 'failed' : 'completed',
    runtime: bridge,
    note: state === 'down' ? 'Realtime bridge reconnecting…' : 'Realtime bridge reconnected.',
    reason,
    createdAt: currentIsoTime(),
    settledAt: state === 'up' ? currentIsoTime() : undefined,
  };
  broadcastRealtimeEvents([
    buildRealtimeEnvelope(
      'global',
      'mutation',
      'mutation.record',
      { mutation },
      {
        entityId: `realtime-bridge:${bridge}`,
        health: state === 'down' ? { state: 'degraded', reason } : { state: 'live' },
      },
    ),
  ]);
}

function mutationToLaneLifecyclePayload(
  mutation: RealtimeMutationRecord,
): LaneLifecycleEventPayload | null {
  if (mutation.action !== 'lane-lifecycle') return null;
  if (!mutation.laneId || !mutation.laneStatus || !mutation.branch || !mutation.repoPath || !mutation.timestamp) {
    return null;
  }

  return {
    laneId: mutation.laneId,
    packetId: mutation.packetId ?? null,
    status: mutation.laneStatus,
    previousStatus: mutation.previousStatus ?? null,
    sessionKey: mutation.sessionKey ?? null,
    branch: mutation.branch,
    repoPath: mutation.repoPath,
    timestamp: mutation.timestamp,
  };
}

function clampRealtimeLog() {
  if (realtimeLog.length <= REALTIME_LOG_LIMIT) return;
  realtimeLog.splice(0, realtimeLog.length - REALTIME_LOG_LIMIT);
}

function normalizeRealtimeStreamKey(raw: string | undefined, sessionKey?: string | null): RealtimeStreamKey | null {
  if (!raw) return null;
  if (raw === 'global') return 'global';
  if (raw === 'session' || raw === 'session:*') {
    return sessionKey ? `session:${sessionKey}` : null;
  }
  if (raw.startsWith('session:')) return raw as RealtimeStreamKey;
  return null;
}

function eventMatchesRealtimeSubscription(
  envelope: RealtimeEventEnvelope,
  subscription: RealtimeSubscription,
  client: ClientState,
) {
  if (envelope.stream !== subscription.stream) return false;
  if (envelope.audience === MOBILE_INBOX_DELTA_CAPABILITY) {
    return client.realtimeCapabilities.has(MOBILE_INBOX_DELTA_CAPABILITY);
  }
  if (envelope.audience === 'mobile-inbox-legacy') {
    return !client.realtimeCapabilities.has(MOBILE_INBOX_DELTA_CAPABILITY);
  }
  return true;
}

function sendRealtimeBatch(
  client: ClientState,
  stream: RealtimeStreamKey,
  delivery: RealtimeBatchMessage['delivery'],
  events: RealtimeEventEnvelope[],
  gap?: RealtimeBatchMessage['gap'],
) {
  if (!events.length) return;
  send(client, {
    channel: 'realtime',
    event: 'batch',
    data: {
      delivery,
      stream,
      events,
      latestSeq: events[events.length - 1]?.seq ?? realtimeSeq,
      gap,
    } satisfies RealtimeBatchMessage,
  });
}

function buildRealtimeEnvelope(
  stream: RealtimeStreamKey,
  channel: RealtimeEventEnvelope['channel'],
  event: RealtimeEventEnvelope['event'],
  data: RealtimeEventEnvelope['data'],
  options: {
    snapshot?: boolean;
    health?: RealtimeHealthDescriptor;
    entityId?: string;
    delivery?: RealtimeEventEnvelope['delivery'];
    capturedSeq?: number;
    audience?: RealtimeEventEnvelope['audience'];
  } = {},
): RealtimeEventEnvelope {
  const envelope: RealtimeEventEnvelope = {
    protocol: 1,
    seq: ++realtimeSeq,
    capturedSeq: options.capturedSeq,
    stream,
    channel,
    event,
    ts: currentIsoTime(),
    snapshot: options.snapshot,
    delivery: options.delivery,
    entityId: options.entityId,
    health: options.health,
    audience: options.audience,
    data,
  };

  if (options.delivery !== 'bootstrap') {
    realtimeLog.push(envelope);
    clampRealtimeLog();
  }

  return envelope;
}

function broadcastRealtimeEvents(events: RealtimeEventEnvelope[]) {
  if (!events.length) return;
  const eventsByStream = new Map<RealtimeStreamKey, RealtimeEventEnvelope[]>();

  for (const event of events) {
    const bucket = eventsByStream.get(event.stream);
    if (bucket) {
      bucket.push(event);
    } else {
      eventsByStream.set(event.stream, [event]);
    }
  }

  for (const client of clients.values()) {
    for (const subscription of client.realtimeSubscriptions) {
      const matching = eventsByStream.get(subscription.stream);
      if (!matching?.length) continue;
      const visible = matching.filter((event) =>
        eventMatchesRealtimeSubscription(event, subscription, client));
      if (visible.length > 0) {
        sendRealtimeBatch(client, subscription.stream, 'live', visible);
      }
    }
  }
}

function retainedEventsForStream(stream: RealtimeStreamKey) {
  return realtimeLog.filter((event) => event.stream === stream);
}

function earliestRetainedSeq(stream: RealtimeStreamKey) {
  return retainedEventsForStream(stream)[0]?.seq;
}

function replayRealtimeSubscriptions(client: ClientState, subscriptions: RealtimeSubscription[]) {
  client.realtimeSubscriptions = subscriptions;

  for (const subscription of subscriptions) {
    const stream = subscription.stream;
    const since = subscription.since ?? 0;
    const earliestAvailable = earliestRetainedSeq(stream);
    if (since > 0 && (earliestAvailable == null || since < (earliestAvailable - 1))) {
      void buildResyncEvents(stream).then((events) => {
        sendRealtimeBatch(client, stream, 'bootstrap', events, {
          requestedSince: since,
          earliestAvailable: earliestAvailable ?? (realtimeSeq + 1),
        });
      });
      continue;
    }
    const replay = realtimeLog.filter((event) => (
      event.seq > since && eventMatchesRealtimeSubscription(event, subscription, client)
    ));
    if (replay.length > 0) {
      sendRealtimeBatch(client, stream, 'replay', replay);
    }
  }
}

async function buildResyncEvents(stream: RealtimeStreamKey) {
  const capturedSeq = realtimeSeq;
  if (stream === 'global') {
    try {
      const snapshot = await fetchCommandCenterSnapshot(true);
      const degradedHealth: RealtimeHealthDescriptor = {
        state: 'degraded',
        reason: 'Replay gap detected; forcing fresh global resync.',
      };
      const events: RealtimeEventEnvelope[] = [
        buildRealtimeEnvelope(
          'global',
          'runtime',
          'runtime.snapshot',
          { fleet: snapshot.fleet },
          { snapshot: true, entityId: 'fleet', health: degradedHealth, capturedSeq },
        ),
        buildRealtimeEnvelope(
          'global',
          'review',
          'review.snapshot',
          { review: snapshot.review, error: snapshot.reviewError ?? null },
          { snapshot: true, entityId: 'workflow-review', health: degradedHealth, capturedSeq },
        ),
        buildRealtimeEnvelope(
          'global',
          'browser',
          'browser.snapshot',
          {
            browserInventory: snapshot.browserInventory,
            attachedBrowser: snapshot.attachedBrowser,
            error: snapshot.browserError ?? null,
          },
          { snapshot: true, entityId: 'browser-inventory', health: degradedHealth, capturedSeq },
        ),
      ];

      const inboxCheckpoint = await getRegisteredMobileInboxCheckpoint().catch(() => null);
      if (inboxCheckpoint) {
        events.push(buildRealtimeEnvelope(
          'global',
          'mobile',
          'mobile.inbox.snapshot',
          { inbox: inboxCheckpoint.inbox, revision: inboxCheckpoint.revision },
          { snapshot: true, entityId: 'mobile-inbox', health: degradedHealth, capturedSeq },
        ));
      }

      return events;
    } catch {
      return [] as RealtimeEventEnvelope[];
    }
  }

  if (!stream.startsWith('session:')) return [] as RealtimeEventEnvelope[];
  const sessionKey = stream.slice('session:'.length);
  if (!sessionKey) return [] as RealtimeEventEnvelope[];

  try {
    const entries = await getSessionTranscript(sessionKey, 24, true);
    // An empty snapshot with replace:true would wipe transcript entries the
    // client accumulated via deltas — getSessionTranscript is currently a
    // stub, so never broadcast a destructive empty replace.
    if (entries.length === 0) return [] as RealtimeEventEnvelope[];
    return [
      buildRealtimeEnvelope(
        stream,
        'history',
        'history.snapshot',
        { sessionKey, entries, replace: true },
        {
          snapshot: true,
          entityId: sessionKey,
          capturedSeq,
          health: {
            state: 'degraded',
            reason: 'Replay gap detected; forcing fresh session resync.',
          },
        },
      ),
    ];
  } catch {
    return [] as RealtimeEventEnvelope[];
  }
}

async function buildBootstrapEvents(stream: RealtimeStreamKey) {
  const capturedSeq = realtimeSeq;
  if (stream === 'global') {
    try {
      const snapshot = await fetchCommandCenterSnapshot(false);
      const runtimeHealth = deriveRuntimeHealth(snapshot.fleet);
      const events: RealtimeEventEnvelope[] = [
        buildRealtimeEnvelope(
          'global',
          'runtime',
          'runtime.snapshot',
          { fleet: snapshot.fleet },
          { snapshot: true, entityId: 'fleet', health: runtimeHealth, delivery: 'bootstrap', capturedSeq },
        ),
        buildRealtimeEnvelope(
          'global',
          'review',
          'review.snapshot',
          { review: snapshot.review, error: snapshot.reviewError ?? null },
          {
            snapshot: true,
            entityId: 'workflow-review',
            health: snapshot.reviewError ? { state: 'stale', reason: snapshot.reviewError } : runtimeHealth,
            delivery: 'bootstrap',
            capturedSeq,
          },
        ),
        buildRealtimeEnvelope(
          'global',
          'browser',
          'browser.snapshot',
          {
            browserInventory: snapshot.browserInventory,
            attachedBrowser: snapshot.attachedBrowser,
            error: snapshot.browserError ?? null,
          },
          {
            snapshot: true,
            entityId: 'browser-inventory',
            health: snapshot.browserError ? { state: 'stale', reason: snapshot.browserError } : runtimeHealth,
            delivery: 'bootstrap',
            capturedSeq,
          },
        ),
      ];

      const inboxCheckpoint = await getRegisteredMobileInboxCheckpoint().catch(() => null);
      if (inboxCheckpoint) {
        events.push(buildRealtimeEnvelope(
          'global',
          'mobile',
          'mobile.inbox.snapshot',
          { inbox: inboxCheckpoint.inbox, revision: inboxCheckpoint.revision },
          {
            snapshot: true,
            entityId: 'mobile-inbox',
            health: inboxCheckpoint.inbox.mode === 'live'
              ? { state: 'live' }
              : { state: 'degraded', reason: inboxCheckpoint.inbox.note },
            delivery: 'bootstrap',
            capturedSeq,
          },
        ));
      }

      return events;
    } catch {
      return [] as RealtimeEventEnvelope[];
    }
  }

  if (!stream.startsWith('session:')) return [] as RealtimeEventEnvelope[];
  const sessionKey = stream.slice('session:'.length);
  if (!sessionKey) return [] as RealtimeEventEnvelope[];

  try {
    const entries = await getSessionTranscript(sessionKey, 24, false);
    // Same guard as the replay-gap path — never replace client history with nothing.
    if (entries.length === 0) return [] as RealtimeEventEnvelope[];
    return [
      buildRealtimeEnvelope(
        stream,
        'history',
        'history.snapshot',
        { sessionKey, entries, replace: true },
        {
          snapshot: true,
          entityId: sessionKey,
          health: { state: 'live' },
          delivery: 'bootstrap',
          capturedSeq,
        },
      ),
    ];
  } catch {
    return [] as RealtimeEventEnvelope[];
  }
}

function fingerprintRuntimeSnapshot(fleet: CommandCenterSnapshot['fleet']) {
  // Lightweight string concat instead of JSON.stringify on nested objects.
  // Same change-detection semantics — all discriminating fields are represented.
  const m = fleet.meta;
  let fp = `${m.mode}\x01${m.gatewayFreshness ?? ''}\x01${m.observablePending ? 1 : 0}\x01${m.primarySessionKey ?? ''}`;
  for (const a of fleet.agents) {
    fp += `\x02${a.id}\x01${a.status}\x01${a.currentTask}\x01${a.approvalStatus}\x01${a.lastEventAt}\x01${Math.round(a.context.usedPercent ?? 0)}\x01${a.alerts}\x01${a.runtimeSurface?.lifecycle?.availability ?? ''}\x01${a.runtimeSurface?.lifecycle?.lastOutcome ?? ''}\x01${a.activity?.headline ?? ''}\x01${a.browserSurface?.lastAction ?? ''}`;
  }
  return fp;
}

// #1650: hash the COMPLETE wire payload (minus the volatile generatedAt
// stamp) instead of hand-picking fields — same lesson as the inbox
// fingerprint below. The old hand-picked review/browser fingerprints were
// lossy, and the options.fresh gate bypass papered over that by
// re-broadcasting identical snapshots on every event-driven nudge (measured
// 5.8Hz each on the mobile global stream). A complete fingerprint makes the
// bypass unnecessary; the gate decides purely on content.
function fingerprintReviewSnapshot(review: CommandCenterSnapshot['review'], error: string | null = null) {
  if (!review) return `no-review\x01${error ?? ''}`;
  const { generatedAt: _generatedAt, ...semantic } = review;
  return createHash('sha256').update(JSON.stringify({ review: semantic, error })).digest('base64url');
}

function fingerprintBrowserSnapshot(
  browserInventory: CommandCenterSnapshot['browserInventory'],
  attachedBrowser: BrowserAttachmentSummary | null,
  error: string | null = null,
) {
  const { generatedAt: _generatedAt, ...semanticInventory } = browserInventory;
  return createHash('sha256').update(JSON.stringify({ inventory: semanticInventory, attachedBrowser, error })).digest('base64url');
}

function fingerprintInboxSnapshot(inbox: Awaited<ReturnType<typeof getMobileInboxSnapshot>>) {
  // Hash the complete wire snapshot. The older hand-picked fingerprint missed
  // approval/review field updates and could suppress an operationally relevant
  // delta even though the JSON sent to the phone had changed. generatedAt is
  // intentionally excluded so an unchanged 30s safety read emits no empty delta.
  const { generatedAt: _generatedAt, ...semanticSnapshot } = inbox;
  return createHash('sha256').update(JSON.stringify(semanticSnapshot)).digest('base64url');
}

function fingerprintHistory(sessionKey: string, entries: Awaited<ReturnType<typeof getSessionTranscript>>) {
  let fp = sessionKey;
  for (const e of entries) fp += `\x02${e.id}\x01${e.timestamp ?? 0}\x01${e.role}\x01${e.text.slice(0, 80)}`;
  return fp;
}

function deriveRuntimeHealth(fleet: CommandCenterSnapshot['fleet']): RealtimeHealthDescriptor {
  if (fleet.meta.mode !== 'live') {
    return { state: 'degraded', reason: fleet.meta.note ?? 'demo fallback' };
  }
  if (fleet.meta.gatewayFreshness === 'stale') {
    return { state: 'stale', reason: fleet.meta.gatewayLabel ?? 'gateway status is stale' };
  }
  if (fleet.meta.gatewayFreshness === 'warming' || fleet.meta.observablePending) {
    return { state: 'warming', reason: fleet.meta.gatewayLabel ?? 'runtime state is warming' };
  }
  return { state: 'live' };
}

async function publishGlobalRealtimeSnapshot(options: { fresh?: boolean; reason?: string } = {}) {
  // Backoff gate: after consecutive bridge failures, skip attempts until the
  // retry window opens — the periodic caller re-invokes, so no reschedule needed.
  if (!canAttemptRealtimeBridge(globalSnapshotBridgeBackoff)) return;
  // Single-flight: fold an overlapping call into one trailing re-fire instead of
  // launching a second concurrent fetch (which is how the timeout spiral started).
  if (globalSnapshotInFlight) {
    globalSnapshotRerequest = {
      fresh: Boolean(globalSnapshotRerequest?.fresh) || Boolean(options.fresh),
      reason: options.reason ?? globalSnapshotRerequest?.reason,
    };
    return;
  }
  globalSnapshotInFlight = true;
  try {
    const snapshot = await fetchCommandCenterSnapshot(Boolean(options.fresh));
    recordBridgeChannelSuccess('global-snapshot');
    const success = recordRealtimeBridgeSuccess(globalSnapshotBridgeBackoff);
    if (success.transition === 'up') {
      console.log('[ws-server] realtime global snapshot recovered');
      publishRealtimeBridgeConnectionState('global-snapshot', 'up');
    }
    const runtimeHealth = deriveRuntimeHealth(snapshot.fleet);
    const events: RealtimeEventEnvelope[] = [];

    const runtimeFingerprint = fingerprintRuntimeSnapshot(snapshot.fleet);
    if (runtimeFingerprint !== lastRealtimeFingerprint.runtime) {
      lastRealtimeFingerprint.runtime = runtimeFingerprint;
      events.push(buildRealtimeEnvelope(
        'global',
        'runtime',
        'runtime.snapshot',
        { fleet: snapshot.fleet },
        { snapshot: true, entityId: 'fleet', health: runtimeHealth },
      ));
    }

    const reviewFingerprint = fingerprintReviewSnapshot(snapshot.review, snapshot.reviewError ?? null);
    if (reviewFingerprint !== lastRealtimeFingerprint.review) {
      const sinceLastReview = Date.now() - lastGlobalSnapshotEmitAt.review;
      if (sinceLastReview < GLOBAL_SNAPSHOT_MIN_EMIT_MS) {
        // Stored fingerprint stays untouched so the trailing refresh still
        // sees the change — or coalesces it away if content reverted.
        scheduleRealtimeRuntimeRefresh({ reason: 'review.coalesce', delayMs: GLOBAL_SNAPSHOT_MIN_EMIT_MS - sinceLastReview });
      } else {
        lastRealtimeFingerprint.review = reviewFingerprint;
        lastGlobalSnapshotEmitAt.review = Date.now();
        events.push(buildRealtimeEnvelope(
          'global',
          'review',
          'review.snapshot',
          { review: snapshot.review, error: snapshot.reviewError ?? null },
          {
            snapshot: true,
            entityId: 'workflow-review',
            health: snapshot.reviewError ? { state: 'stale', reason: snapshot.reviewError } : runtimeHealth,
          },
        ));
      }
    }

    const browserFingerprint = fingerprintBrowserSnapshot(snapshot.browserInventory, snapshot.attachedBrowser, snapshot.browserError ?? null);
    if (browserFingerprint !== lastRealtimeFingerprint.browser) {
      const sinceLastBrowser = Date.now() - lastGlobalSnapshotEmitAt.browser;
      if (sinceLastBrowser < GLOBAL_SNAPSHOT_MIN_EMIT_MS) {
        scheduleRealtimeRuntimeRefresh({ reason: 'browser.coalesce', delayMs: GLOBAL_SNAPSHOT_MIN_EMIT_MS - sinceLastBrowser });
      } else {
        lastRealtimeFingerprint.browser = browserFingerprint;
        lastGlobalSnapshotEmitAt.browser = Date.now();
        events.push(buildRealtimeEnvelope(
          'global',
          'browser',
          'browser.snapshot',
          {
            browserInventory: snapshot.browserInventory,
            attachedBrowser: snapshot.attachedBrowser,
            error: snapshot.browserError ?? null,
          },
          {
            snapshot: true,
            entityId: 'browser-inventory',
            health: snapshot.browserError ? { state: 'stale', reason: snapshot.browserError } : runtimeHealth,
          },
        ));
      }
    }

    broadcastRealtimeEvents(events);

    // #476 — Prune stale history fingerprint entries for sessions no longer in fleet
    if (lastRealtimeFingerprint.history.size > 50) {
      const liveKeys = new Set(snapshot.fleet.agents.map((a: { sessionKey: string }) => a.sessionKey));
      for (const key of lastRealtimeFingerprint.history.keys()) {
        if (!liveKeys.has(key)) lastRealtimeFingerprint.history.delete(key);
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'unknown';
    // Silently skip transient 404s during startup / packet transitions — the route
    // exists but Next.js may not have compiled/rendered it yet.
    if (typeof msg === 'string' && msg.includes('(404)')) return;
    const failure = recordRealtimeBridgeFailure(globalSnapshotBridgeBackoff);
    if (failure.transition === 'down') {
      if (await shouldOverrideBridgeDown('global-snapshot')) {
        recordRealtimeBridgeSuccess(globalSnapshotBridgeBackoff);
        console.warn('[ws-server] realtime global snapshot slow but next-server alive — staying up:', msg);
      } else {
        console.error('[ws-server] realtime global snapshot unavailable:', msg);
        publishRealtimeBridgeConnectionState('global-snapshot', 'down', msg);
      }
    }
  } finally {
    globalSnapshotInFlight = false;
    if (globalSnapshotRerequest) {
      const next = globalSnapshotRerequest;
      globalSnapshotRerequest = null;
      void publishGlobalRealtimeSnapshot(next);
    }
  }
}

async function publishMobileInboxRealtimeSnapshot(fresh = false) {
  if (!canAttemptRealtimeBridge(mobileInboxBridgeBackoff)) {
    scheduleRealtimeMobileInboxRefresh(getRealtimeBridgeRetryDelay(mobileInboxBridgeBackoff), fresh);
    return;
  }
  // Single-flight: fold an overlapping call into one trailing re-fire (see above).
  if (mobileSnapshotInFlight) {
    mobileSnapshotRerequest = {
      fresh: Boolean(mobileSnapshotRerequest?.fresh) || fresh,
    };
    return;
  }
  mobileSnapshotInFlight = true;
  try {
    const inbox = await getMobileInboxSnapshot({ fresh });
    recordBridgeChannelSuccess('mobile-inbox');
    const success = recordRealtimeBridgeSuccess(mobileInboxBridgeBackoff);
    if (success.transition === 'up') {
      console.log('[ws-server] realtime mobile inbox snapshot recovered');
      publishRealtimeBridgeConnectionState('mobile-inbox', 'up');
    }
    void import('@/lib/mobile/live-activity-push')
      .then(({ syncMobileLiveActivities }) => syncMobileLiveActivities(inbox))
      .catch((error) => {
        console.warn('[ws-server] live activity sync failed:', error instanceof Error ? error.message : 'unknown');
      });
    const fingerprint = fingerprintInboxSnapshot(inbox);
    if (fingerprint === lastRealtimeFingerprint.mobileInbox) return;
    const previous = lastMobileInboxSnapshot;
    const baseRevision = mobileInboxRevision;
    mobileInboxRevision += 1;
    lastMobileInboxSnapshot = inbox;
    lastRealtimeFingerprint.mobileInbox = fingerprint;
    const health: RealtimeHealthDescriptor = inbox.mode === 'live'
      ? { state: 'live' }
      : { state: 'degraded', reason: inbox.note };

    if (!previous) {
      mobileInboxDeltasSinceCheckpoint = 0;
      broadcastRealtimeEvents([
        buildRealtimeEnvelope(
          'global',
          'mobile',
          'mobile.inbox.snapshot',
          { inbox, revision: mobileInboxRevision },
          { snapshot: true, entityId: 'mobile-inbox', health },
        ),
      ]);
      return;
    }

    const delta = buildMobileInboxDelta(
      previous,
      inbox,
      baseRevision,
      mobileInboxRevision,
    );
    const snapshotBytes = JSON.stringify(inbox).length;
    const deltaBytes = JSON.stringify(delta).length;
    const checkpointDue =
      mobileInboxDeltasSinceCheckpoint >= MOBILE_INBOX_CHECKPOINT_INTERVAL - 1 ||
      deltaBytes >= snapshotBytes * 0.8;

    if (checkpointDue) {
      mobileInboxDeltasSinceCheckpoint = 0;
      broadcastRealtimeEvents([
        buildRealtimeEnvelope(
          'global',
          'mobile',
          'mobile.inbox.snapshot',
          { inbox, revision: mobileInboxRevision },
          { snapshot: true, entityId: 'mobile-inbox', health },
        ),
      ]);
      return;
    }

    mobileInboxDeltasSinceCheckpoint += 1;
    broadcastRealtimeEvents([
      // Legacy realtime consumers continue receiving the exact full-snapshot
      // event until they explicitly negotiate the additive delta capability.
      buildRealtimeEnvelope(
        'global',
        'mobile',
        'mobile.inbox.snapshot',
        { inbox, revision: mobileInboxRevision },
        {
          snapshot: true,
          entityId: 'mobile-inbox',
          health,
          audience: 'mobile-inbox-legacy',
        },
      ),
      buildRealtimeEnvelope(
        'global',
        'mobile',
        'mobile.inbox.delta',
        { delta },
        {
          entityId: 'mobile-inbox',
          health,
          audience: MOBILE_INBOX_DELTA_CAPABILITY,
        },
      ),
    ]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown';
    const failure = recordRealtimeBridgeFailure(mobileInboxBridgeBackoff);
    if (failure.transition === 'down') {
      if (await shouldOverrideBridgeDown('mobile-inbox')) {
        recordRealtimeBridgeSuccess(mobileInboxBridgeBackoff);
        console.warn('[ws-server] realtime mobile inbox slow but next-server alive — staying up:', reason);
      } else {
        console.error('[ws-server] realtime mobile inbox snapshot unavailable:', reason);
        publishRealtimeBridgeConnectionState('mobile-inbox', 'down', reason);
      }
    }
  } finally {
    mobileSnapshotInFlight = false;
    if (mobileSnapshotRerequest) {
      const next = mobileSnapshotRerequest;
      mobileSnapshotRerequest = null;
      scheduleRealtimeMobileInboxRefresh(250, next.fresh);
    }
  }
}

async function publishSessionHistoryRealtimeSnapshot(sessionKey: string, fresh = false) {
  if (!sessionKey) return;
  try {
    const entries = await getSessionTranscript(sessionKey, 24, fresh);
    // Stub returns [] — broadcasting an empty snapshot tells clients their
    // transcript is now empty. Skip until a real transcript source exists.
    if (entries.length === 0) return;
    const fingerprint = fingerprintHistory(sessionKey, entries);
    if (!fresh && lastRealtimeFingerprint.history.get(sessionKey) === fingerprint) return;
    lastRealtimeFingerprint.history.set(sessionKey, fingerprint);

    broadcastRealtimeEvents([
      buildRealtimeEnvelope(
        `session:${sessionKey}`,
        'history',
        'history.snapshot',
        { sessionKey, entries },
        {
          snapshot: true,
          entityId: sessionKey,
          health: { state: 'live' },
        },
      ),
    ]);
  } catch (error) {
    console.error('[ws-server] realtime session history failed:', error instanceof Error ? error.message : 'unknown');
  }
}

function scheduleRealtimeRuntimeRefresh(options: { fresh?: boolean; reason?: string; delayMs?: number } = {}) {
  runtimeRefreshFreshRequested = runtimeRefreshFreshRequested || Boolean(options.fresh);
  if (runtimeRefreshTimer) return;
  runtimeRefreshTimer = setTimeout(() => {
    const fresh = runtimeRefreshFreshRequested;
    runtimeRefreshFreshRequested = false;
    runtimeRefreshTimer = null;
    void publishGlobalRealtimeSnapshot({ fresh, reason: options.reason });
  // delayMs carries the #1650 coalesce floor's trailing edge — a suppressed
  // review/browser change re-publishes exactly when its 1s window opens.
  }, options.delayMs ?? (options.fresh ? 50 : 250));
}

function scheduleRealtimeMobileInboxRefresh(delayMs = 250, fresh = false) {
  const resolvedDelayMs = Math.max(delayMs, getRealtimeBridgeRetryDelay(mobileInboxBridgeBackoff));
  if (mobileRefreshTimer) {
    mobileRefreshFreshRequested = mobileRefreshFreshRequested || fresh;
    return;
  }
  mobileRefreshFreshRequested = mobileRefreshFreshRequested || fresh;
  mobileRefreshTimer = setTimeout(() => {
    const nextFresh = mobileRefreshFreshRequested;
    mobileRefreshFreshRequested = false;
    mobileRefreshTimer = null;
    void publishMobileInboxRealtimeSnapshot(nextFresh);
  }, resolvedDelayMs);
}

// Urgent debounce for chat.done paths — must beat the 350ms inbox cadence so
// transcript slices land within ~100ms of the stream completing. Per-session
// timer map still coalesces; the second caller's `fresh` flag wins via the
// closure re-capture on the new timer.
const URGENT_HISTORY_REFRESH_MS = 80;

function scheduleRealtimeSessionHistoryRefresh(
  sessionKey: string,
  fresh = false,
  delayMs?: number,
  options: { urgent?: boolean } = {},
) {
  const resolvedDelay = delayMs ?? (options.urgent ? URGENT_HISTORY_REFRESH_MS : 350);
  const existing = sessionHistoryTimers.get(sessionKey);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    sessionHistoryTimers.delete(sessionKey);
    void publishSessionHistoryRealtimeSnapshot(sessionKey, fresh);
  }, resolvedDelay);
  sessionHistoryTimers.set(sessionKey, timer);
}

function startHeadlessTickBridge(intervalMs: number) {
  const tick = () => {
    if (headlessTickBridgeInFlight) return;
    if (!canAttemptRealtimeBridge(headlessTickBridgeBackoff)) return;
    headlessTickBridgeInFlight = true;
    void triggerHeadlessSprintTick()
      .then(() => {
        recordBridgeChannelSuccess('headless-tick');
        const success = recordRealtimeBridgeSuccess(headlessTickBridgeBackoff);
        if (success.transition === 'up') {
          console.log('[headless] Tick bridge recovered');
          publishRealtimeBridgeConnectionState('headless-tick', 'up');
        }
      })
      .catch((error) => {
        const reason = error instanceof Error ? error.message : String(error);
        const failure = recordRealtimeBridgeFailure(headlessTickBridgeBackoff);
        if (failure.transition === 'down') {
          void shouldOverrideBridgeDown('headless-tick').then((alive) => {
            if (alive) {
              recordRealtimeBridgeSuccess(headlessTickBridgeBackoff);
              console.warn('[headless] Tick bridge slow but next-server alive — staying up:', reason);
            } else {
              console.error('[headless] Tick bridge unavailable:', reason);
              publishRealtimeBridgeConnectionState('headless-tick', 'down', reason);
            }
          });
        }
      })
      .finally(() => {
        headlessTickBridgeInFlight = false;
      });
  };

  const timer = setInterval(() => {
    tick();
  }, intervalMs);

  if (timer.unref) timer.unref();

  console.log(`[headless] Started sprint loop (${intervalMs}ms interval)`);
  tick();

  return () => {
    clearInterval(timer);
    console.log('[headless] Stopped sprint loop');
  };
}

function startBrowserDiscoveryRealtimeLoop() {
  if (browserDiscoveryTimer) return;
  browserDiscoveryTimer = setInterval(async () => {
    if (clients.size === 0) return;
    try {
      const browserInventory = await fetchBrowserInventorySnapshot();
      const attachedBrowser = getAttachedBrowserSummary();
      const fingerprint = fingerprintBrowserSnapshot(browserInventory, attachedBrowser);
      if (fingerprint === lastRealtimeFingerprint.browser) return;
      lastRealtimeFingerprint.browser = fingerprint;
      lastGlobalSnapshotEmitAt.browser = Date.now();
      broadcastRealtimeEvents([
        buildRealtimeEnvelope(
          'global',
          'browser',
          'browser.snapshot',
          {
            browserInventory,
            attachedBrowser,
            error: null,
          },
          { snapshot: true, entityId: 'browser-inventory', health: { state: 'live' } },
        ),
      ]);
    } catch {
      // Best-effort discovery loop
    }
  }, BROWSER_DISCOVERY_INTERVAL_MS);
  if (browserDiscoveryTimer.unref) browserDiscoveryTimer.unref();
}

function attachedBrowserFingerprint(summary: BrowserAttachmentSummary | null) {
  if (!summary) return 'no-attached-browser';
  let fp = `${summary.provider}\x01${summary.surface.id}\x01${summary.surface.status}\x01${summary.surface.url}\x01${summary.surface.title}\x01${summary.browserName}\x01${summary.browserVersion}\x01${summary.attachedAt}\x01${summary.note ?? ''}`;
  for (const page of summary.pages) {
    fp += `\x02${page.id}\x01${page.title}\x01${page.url}\x01${page.status}\x01${page.type}`;
  }
  return fp;
}

function startAttachedBrowserRefreshLoop() {
  if (attachedBrowserRefreshTimer) return;
  attachedBrowserRefreshTimer = setInterval(async () => {
    if (clients.size === 0) return;
    const attachedBrowser = getAttachedBrowserSummary();
    if (!attachedBrowser) return;

    const provider = getBrowserProvider(attachedBrowser.provider);
    if (!provider?.attachSurface) return;

    try {
      const refreshed = await provider.attachSurface(attachedBrowser.surface.id);
      const previousFingerprint = attachedBrowserFingerprint(attachedBrowser);
      const nextFingerprint = attachedBrowserFingerprint(refreshed);
      if (previousFingerprint === nextFingerprint) return;

      setAttachedBrowserSummary(refreshed);

      scheduleRealtimeRuntimeRefresh({ reason: `browser.attach-refresh:${refreshed.provider}`, fresh: true });
    } catch {
      // If the attached surface disappears, keep the last known state until an explicit attach replaces it.
    }
  }, ATTACHED_BROWSER_REFRESH_MS);
  if (attachedBrowserRefreshTimer.unref) attachedBrowserRefreshTimer.unref();
}

// ── Client management ──

const clients = new Map<string, ClientState>();

function handleClientMessage(client: ClientState, raw: string) {
  let msg: Record<string, unknown>;
  try { msg = JSON.parse(raw); } catch { return; }

  // #5 E2EE — once the channel is encrypted, every inbound frame is an
  // {e2ee,n,c} envelope; decrypt it back to the real message before routing.
  if (isEncryptedFrame(msg)) {
    if (client.e2ee?.state !== 'encrypted' || !client.e2ee.sessionKey) return; // can't decrypt — drop
    const plaintext = decryptFrame(msg, client.e2ee.sessionKey);
    if (!plaintext) return; // bad/forged frame — drop
    try { msg = JSON.parse(plaintext); } catch { return; }
  }

  // #5 E2EE — the client's handshake response (plaintext, signed).
  if (msg.type === 'e2ee-init') {
    handleE2eeInit(client, msg);
    return;
  }

  switch (msg.type) {
    case 'subscribe':
    case 'switch-session': {
      const sessionKey = typeof msg.sessionKey === 'string' ? msg.sessionKey : null;
      client.sessionKey = sessionKey;
      client.lastHistoryId = null;
      // Send immediate sync for the new session
      if (sessionKey) {
        void syncClientHistory(client);
      }
      break;
    }
    case 'realtime-subscribe': {
      const requestedCapabilities = Array.isArray(msg.capabilities)
        ? msg.capabilities.filter((value): value is string => typeof value === 'string')
        : [];
      client.realtimeCapabilities = new Set(
        requestedCapabilities.filter((value) => value === MOBILE_INBOX_DELTA_CAPABILITY),
      );
      const rawSubscriptions = Array.isArray(msg.subscriptions) ? msg.subscriptions as Array<Record<string, unknown>> : [];
      const subscriptions: RealtimeSubscription[] = [];
      for (const item of rawSubscriptions) {
        const sessionKey = typeof item.sessionKey === 'string' ? item.sessionKey : null;
        const stream = normalizeRealtimeStreamKey(typeof item.stream === 'string' ? item.stream : undefined, sessionKey);
        if (!stream) continue;
        const since = typeof item.since === 'number' && Number.isFinite(item.since) ? item.since : undefined;
        subscriptions.push({ stream, since });
      }

      replayRealtimeSubscriptions(client, subscriptions);
      for (const subscription of subscriptions) {
        if (subscription.since != null) continue;
        void buildBootstrapEvents(subscription.stream).then((events) => {
          sendRealtimeBatch(client, subscription.stream, 'bootstrap', events);
        });
      }
      break;
    }
    case 'ping':
      send(client, { channel: 'pong', ts: Date.now() });
      break;
    case 'packet-tail-subscribe': {
      const packetId = typeof msg.packetId === 'string' ? msg.packetId.trim() : '';
      if (!packetId) {
        send(client, { channel: 'packet-tail', type: 'error', error: 'packetId is required' });
        break;
      }
      client.packetTailSubscriptions.add(packetId);
      send(client, { channel: packetTailChannel(packetId), type: 'subscribed', packetId });
      void sendPacketTailHistory(client, packetId, parsePacketTailSince(msg.since));
      break;
    }
    case 'packet-tail-unsubscribe': {
      const packetId = typeof msg.packetId === 'string' ? msg.packetId.trim() : '';
      if (packetId) client.packetTailSubscriptions.delete(packetId);
      break;
    }

    // ── Terminal commands ──
    case 'terminal-create':
      handleTerminalCreate(client, msg);
      break;
    case 'terminal-attach':
      handleTerminalAttach(client, msg);
      break;
    case 'terminal-input':
      handleTerminalInput(client, msg);
      break;
    case 'terminal-resize':
      handleTerminalResize(client, msg);
      break;
    case 'terminal-detach':
      handleTerminalDetach(client, msg);
      break;
    case 'terminal-image':
      void handleTerminalImage(client, msg);
      break;
    case 'agent-kill':
      handleAgentKill(client, msg);
      break;

    // ── Orchestrator channel ──
    case 'orchestrator-subscribe':
      handleOrchestratorSubscribe(client, msg);
      break;
    case 'orchestrator-send':
      handleOrchestratorSendMsg(client, msg);
      break;
    case 'orchestrator-status':
      handleOrchestratorStatus(client, msg);
      break;
    case 'orchestrator-unsubscribe':
      handleOrchestratorUnsubscribe(client, msg);
      break;
    case 'orchestrator-interrupt':
      handleOrchestratorInterrupt(client, msg);
      break;
    case 'orchestrator-undo-send':
      handleOrchestratorUndoSend(client, msg);
      break;

    // ── Symon Agent Mode channel (phone-hosted voice, Mac-executed tools) ──
    case 'symon-tool-call':
      void handleSymonToolCall(client, msg);
      break;
    case 'symon-text-turn':
      handleSymonTextTurn(client, msg);
      break;
    case 'symon-text-interrupt':
      void handleSymonTextInterrupt(client, msg);
      break;
    case 'symon-confirm-decision':
      void handleSymonConfirmDecision(client, msg);
      break;
    case 'symon-tool-interrupt':
      void handleSymonToolInterrupt(client, msg);
      break;
    case 'symon-agent-status':
      handleSymonAgentStatus(client, msg);
      break;
    case 'symon-stop':
      handleSymonStop(client, msg);
      break;
  }
}

// ── Symon Agent Mode channel handlers (docs/internals/symon-agent-mode.md) ──
//
// The PHONE hosts the WebRTC voice session; every tool STILL executes here on the
// Mac. This process owns the socket pushes + the one activeAgentSession registry
// (src/lib/mobile/symon-agent-registry.ts), mirrored to disk for the Next GET.
// DURABLE channel: `symon` messages fall through isLossyMessage() → queued under
// backpressure (never dropped), like agent-lifecycle.

type SymonSessionRoute = {
  clientId: string;
  scope: SymonScopeGrant;
  protocolVersion: SymonProtocolVersion;
};

type SymonConfirmationRoute = Pick<SymonSessionRoute, 'clientId' | 'protocolVersion'>;
type SymonTextTurnState = {
  clientId: string;
  sessionId: string;
  turnId: string;
  terminal: boolean;
};

/** sessionId → socket, immutable scope, and negotiated additive protocol. */
const symonSessions = new Map<string, SymonSessionRoute>();
const symonTextOwners = new Map<string, string>();
const symonTextTurns = new Map<string, SymonTextTurnState>();
const symonTextChains = new Map<string, Promise<unknown>>();
/** In-flight + replayable tool calls, correlated by sessionId + callId. */
const symonToolTracker = new ToolCallTracker();
/** Confirmation decisions/tombstones, keyed by sessionId + callId + confirmationId. */
const symonConfirmationTracker = new SymonConfirmationTracker();
/** Accepted Code actions waiting for the correlated lane's terminal transition. */
const symonAsyncActionTracker = new SymonAsyncActionTracker();

function symonProtocolVersion(msg: Record<string, unknown>): SymonProtocolVersion {
  return msg.protocolVersion === 2 ? 2 : 1;
}

const AGENT_STATUSES = new Set<AgentSessionStatus>(['connecting', 'live', 'acting', 'idle', 'error']);
function isAgentSessionStatus(v: string): v is AgentSessionStatus {
  return AGENT_STATUSES.has(v as AgentSessionStatus);
}

function persistAgentRegistry(): void {
  persistAgentSession(getAgentSession());
}

function activeSymonGrant(client: ClientState, sessionId: string): SymonScopeGrant | null {
  const grant = loadSymonScopeGrant();
  if (!grant) return null;
  return scopeGrantMatchesClient(grant, sessionId, {
    subject: client.authKind,
    deviceId: client.deviceId ?? null,
  }) ? grant : null;
}

function isSameSymonGrant(left: SymonScopeGrant, right: SymonScopeGrant): boolean {
  return left.sessionId === right.sessionId
    && left.scopeVersion === right.scopeVersion
    && left.issuedAt === right.issuedAt
    && left.subject === right.subject
    && left.deviceId === right.deviceId;
}

function pushSymonStatus(clientId: string, sessionId: string, status: AgentSessionStatus, detail?: string): void {
  const client = clients.get(clientId);
  if (!client) return;
  send(client, { channel: 'symon', type: 'symon-agent-status', sessionId, status, ...(detail ? { detail } : {}) });
}

function pushSymonToolResult(
  clientId: string,
  sessionId: string,
  callId: string,
  ok: boolean,
  result: unknown,
): void {
  const client = clients.get(clientId);
  if (!client) return;
  send(client, { channel: 'symon', type: 'symon-tool-result', sessionId, callId, ok, result });
}

function pushSymonConfirmRequired(clientId: string, confirmation: SymonPendingConfirmation): void {
  const client = clients.get(clientId);
  if (!client) return;
  send(client, { channel: 'symon', type: 'symon-confirm-required', ...confirmation });
}

function pushSymonConfirmSettled(
  clientId: string,
  confirmation: SymonPendingConfirmation,
  outcome: SymonConfirmationOutcome,
  firstOutcome?: Exclude<SymonConfirmationOutcome, 'duplicate'>,
): void {
  const client = clients.get(clientId);
  if (!client) return;
  send(client, {
    channel: 'symon',
    type: 'symon-confirm-settled',
    sessionId: confirmation.sessionId,
    callId: confirmation.callId,
    confirmationId: confirmation.confirmationId,
    outcome,
    ...(firstOutcome ? { firstOutcome } : {}),
  });
}

function pushSymonActionComplete(clientId: string, action: SymonActionComplete): void {
  const client = clients.get(clientId);
  if (!client) return;
  send(client, { channel: 'symon', type: 'symon-action-complete', ...action });
}

function symonTextClientMatches(record: SymonTextSessionRecord, client: ClientState): boolean {
  return record.subject === client.authKind
    && (record.subject === 'operator' || record.deviceId === client.deviceId);
}

function textTurnKey(sessionId: string, turnId: string): string {
  return JSON.stringify([sessionId, turnId]);
}

function pushSymonTextDone(
  turn: SymonTextTurnState,
  status: 'done' | 'failed' | 'interrupted',
  detail?: string,
): void {
  if (turn.terminal) return;
  turn.terminal = true;
  const client = clients.get(turn.clientId);
  if (client) {
    send(client, {
      channel: 'symon',
      type: 'symon-text-done',
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      status,
      ...(detail ? { detail } : {}),
    });
  }
  setTimeout(() => symonTextTurns.delete(textTurnKey(turn.sessionId, turn.turnId)), 5 * 60_000).unref();
}

async function interruptSymonTextNative(sessionId: string, turnId: string): Promise<boolean> {
  try {
    const response = await fetchNextJson<{ ok?: boolean; active?: boolean }>('/api/mobile/symon/text-turn', {
      method: 'DELETE',
      body: { sessionId, turnId },
      timeoutMs: 8_000,
    });
    return response.ok === true;
  } catch {
    return false;
  }
}

type SymonTextRelayResult = {
  state?: 'pending' | 'done' | 'needs_confirmation' | 'error' | 'call_mismatch';
  result?: { status?: 'done' | 'interrupted'; text?: string };
  confirmation?: unknown;
  detail?: string;
  error?: string;
};

async function runSymonTextTurn(turn: SymonTextTurnState, text: string): Promise<void> {
  const initial = loadSymonTextSession(turn.sessionId);
  if (!initial || turn.terminal) {
    pushSymonTextDone(turn, 'failed', 'Text session expired.');
    return;
  }
  const prompt = formatSymonTextPlannerPrompt(initial, text);
  if (!appendSymonTextTranscript(turn.sessionId, [{ role: 'user', text }])) {
    pushSymonTextDone(turn, 'failed', 'Text session expired.');
    return;
  }
  const client = clients.get(turn.clientId);
  if (client) {
    send(client, {
      channel: 'symon',
      type: 'symon-text-status',
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      status: 'thinking',
    });
  }
  const deadline = Date.now() + 5 * 60_000;
  const mirroredConfirmations = new Set<string>();
  while (!turn.terminal && Date.now() < deadline) {
    let outcome: SymonTextRelayResult;
    try {
      outcome = await fetchNextJson<SymonTextRelayResult>('/api/mobile/symon/text-turn', {
        method: 'POST',
        body: {
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          prompt,
          planner: {
            engine: initial.engine,
            model: initial.model,
            effort: initial.effort,
          },
        },
        timeoutMs: 8_000,
      });
    } catch (error) {
      pushSymonTextDone(turn, 'failed', error instanceof Error ? error.message : 'Planner bridge failed.');
      return;
    }
    if (outcome.state === 'pending') continue;
    if (outcome.state === 'needs_confirmation') {
      const rawTool = outcome.confirmation && typeof outcome.confirmation === 'object'
        ? (outcome.confirmation as Record<string, unknown>).tool
        : null;
      const confirmation = typeof rawTool === 'string'
        ? parseSymonPendingConfirmation(outcome.confirmation, {
          sessionId: turn.sessionId,
          callId: turn.turnId,
          tool: rawTool,
        })
        : null;
      if (!confirmation) {
        pushSymonTextDone(turn, 'failed', 'The desktop returned an uncorrelated confirmation.');
        return;
      }
      if (!mirroredConfirmations.has(confirmation.confirmationId)) {
        if (!symonConfirmationTracker.register(confirmation, Date.now())) {
          pushSymonTextDone(turn, 'failed', 'Confirmation identity collision.');
          return;
        }
        mirroredConfirmations.add(confirmation.confirmationId);
        pushSymonConfirmRequired(turn.clientId, confirmation);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      continue;
    }
    if (outcome.state === 'done' && outcome.result?.status === 'interrupted') {
      pushSymonTextDone(turn, 'interrupted');
      return;
    }
    if (outcome.state === 'done' && typeof outcome.result?.text === 'string') {
      const answer = outcome.result.text;
      appendSymonTextTranscript(turn.sessionId, [{ role: 'assistant', text: answer }]);
      const owner = clients.get(turn.clientId);
      if (owner && answer) {
        send(owner, {
          channel: 'symon',
          type: 'symon-text-delta',
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          delta: answer,
        });
      }
      pushSymonTextDone(turn, 'done');
      return;
    }
    pushSymonTextDone(turn, 'failed', outcome.detail || outcome.error || 'Planner turn failed.');
    return;
  }
  if (!turn.terminal) {
    await interruptSymonTextNative(turn.sessionId, turn.turnId);
    pushSymonTextDone(turn, 'failed', 'Planner turn timed out.');
  }
}

function handleSymonTextTurn(client: ClientState, msg: Record<string, unknown>): void {
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : '';
  const turnId = typeof msg.turnId === 'string' ? msg.turnId : '';
  const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 8_000) : '';
  if (!sessionId || !turnId || !text || sessionId.length > 160 || turnId.length > 160) return;
  const record = loadSymonTextSession(sessionId);
  if (!record || !symonTextClientMatches(record, client)) {
    const rejected: SymonTextTurnState = { clientId: client.id, sessionId, turnId, terminal: false };
    pushSymonTextDone(rejected, 'failed', 'Text session is missing, stale, or belongs to another client.');
    return;
  }
  const key = textTurnKey(sessionId, turnId);
  if (symonTextTurns.has(key)) return;
  const turn: SymonTextTurnState = { clientId: client.id, sessionId, turnId, terminal: false };
  symonTextTurns.set(key, turn);
  symonTextOwners.set(sessionId, client.id);
  void chainOnKey(symonTextChains, sessionId, () => runSymonTextTurn(turn, text));
}

async function handleSymonTextInterrupt(client: ClientState, msg: Record<string, unknown>): Promise<void> {
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : '';
  const turnId = typeof msg.turnId === 'string' ? msg.turnId : '';
  const record = loadSymonTextSession(sessionId);
  if (!record || !symonTextClientMatches(record, client)) return;
  const turn = symonTextTurns.get(textTurnKey(sessionId, turnId));
  if (!turn || turn.clientId !== client.id || turn.terminal) return;
  await interruptSymonTextNative(sessionId, turnId);
  pushSymonTextDone(turn, 'interrupted');
}

async function interruptSymonTool(call: PendingToolCall): Promise<boolean> {
  try {
    const result = await fetchNextJson<{ ok?: boolean; delivered?: boolean }>('/api/mobile/symon/tool', {
      method: 'DELETE',
      body: { sessionId: call.sessionId, callId: call.callId },
      timeoutMs: 5_000,
    });
    return result.ok === true && result.delivered === true;
  } catch (error) {
    console.warn(`[symon-agent] native interrupt failed callId=${call.callId}: ${String(error)}`);
    return false;
  }
}

async function abortSymonSessionCalls(
  sessionId: string,
  route: SymonSessionRoute,
  error: 'session_stopped' | 'session_preempted',
): Promise<void> {
  symonAsyncActionTracker.removeSession(sessionId);
  const calls = symonToolTracker.callsForSession(sessionId);
  const deliveries = await Promise.all(calls.map((call) => interruptSymonTool(call)));
  for (const [index, call] of calls.entries()) {
    const outcome = deliveries[index]
      ? { ok: false, result: { error } }
      : {
        ok: false,
        result: {
          error: 'interrupt_delivery_failed',
          detail: 'Native cancellation could not be delivered; the action outcome is unknown.',
        },
      };
    const completed = symonToolTracker.complete(sessionId, call.callId, outcome, Date.now());
    if (!completed) continue;
    pushSymonToolResult(
      route.clientId,
      sessionId,
      call.callId,
      outcome.ok,
      outcome.result,
    );
    if (route.protocolVersion === 2) pushSymonActionComplete(route.clientId, completed.action);
  }
}

type SymonTaskCompletePayload = {
  taskId: string;
  status: 'done' | 'failed';
  intentText: string;
  resultText: string;
  truncated: boolean;
};

function pushSymonTaskComplete(payload: SymonTaskCompletePayload): number {
  const clientIds = new Set([...symonSessions.values()].map((route) => route.clientId));
  for (const clientId of clientIds) {
    const client = clients.get(clientId);
    if (client) send(client, { channel: 'symon', type: 'symon-task-complete', ...payload });
  }
  return clientIds.size;
}

/** Last-start-wins: idle-push + drop every symon session EXCEPT the one to keep. */
function preemptOtherSymonSessions(keepSessionId: string, detail: string): void {
  for (const [sid, route] of Array.from(symonSessions.entries())) {
    if (sid === keepSessionId) continue;
    void denySymonSessionConfirmations(sid, route, 'preempted');
    void abortSymonSessionCalls(sid, route, 'session_preempted');
    pushSymonStatus(route.clientId, sid, 'idle', detail);
    symonSessions.delete(sid);
    clearSymonScopeGrant(sid);
  }
}

function handleSymonAgentStatus(client: ClientState, msg: Record<string, unknown>): void {
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : '';
  const status = typeof msg.status === 'string' ? msg.status : '';
  if (!sessionId || !isAgentSessionStatus(status)) return;
  const grant = activeSymonGrant(client, sessionId);
  if (!grant) {
    console.warn(`[symon-agent] rejected ungranted status for ${sessionId}`);
    return;
  }
  const existingOwner = symonSessions.get(sessionId);
  if (existingOwner && existingOwner.clientId !== client.id && (status === 'idle' || status === 'error')) return;

  if (status === 'idle' || status === 'error') {
    // Phone tore the session down (user tap / background / WebRTC close).
    const owner = symonSessions.get(sessionId);
    if (owner?.clientId === client.id) {
      void denySymonSessionConfirmations(sessionId, owner, 'preempted');
      void abortSymonSessionCalls(sessionId, owner, 'session_stopped');
      symonSessions.delete(sessionId);
    }
    stopAgentSession(sessionId);
    clearSymonScopeGrant(sessionId);
    persistAgentRegistry();
    return;
  }

  // connecting / live / acting → register + preempt any OTHER live session
  // (last-start-wins; makes phone-app restarts self-healing).
  if (existingOwner && (existingOwner.clientId !== client.id || !isSameSymonGrant(existingOwner.scope, grant))) {
    void denySymonSessionConfirmations(sessionId, existingOwner, 'preempted');
    void abortSymonSessionCalls(sessionId, existingOwner, 'session_preempted');
    pushSymonStatus(existingOwner.clientId, sessionId, 'idle', 'preempted');
  }
  startAgentSession(sessionId);
  symonSessions.set(sessionId, {
    clientId: client.id,
    scope: grant,
    protocolVersion: existingOwner?.protocolVersion === 2 ? 2 : symonProtocolVersion(msg),
  });
  preemptOtherSymonSessions(sessionId, 'preempted');
  updateAgentStatus(sessionId, status);
  persistAgentRegistry();
}

function handleSymonStop(client: ClientState, msg: Record<string, unknown>): void {
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : '';
  if (!sessionId) return;
  const textSession = loadSymonTextSession(sessionId);
  if (textSession && symonTextClientMatches(textSession, client)) {
    for (const turn of symonTextTurns.values()) {
      if (turn.sessionId !== sessionId || turn.terminal) continue;
      void interruptSymonTextNative(turn.sessionId, turn.turnId);
      pushSymonTextDone(turn, 'interrupted');
    }
    symonTextOwners.delete(sessionId);
    dropSymonTextSession(sessionId);
    return;
  }
  const grant = activeSymonGrant(client, sessionId);
  if (!grant) {
    console.warn(`[symon-agent] rejected ungranted stop for ${sessionId}`);
    return;
  }
  const owner = symonSessions.get(sessionId);
  if (owner && owner.clientId !== client.id) return;
  if (owner) void denySymonSessionConfirmations(sessionId, owner, 'preempted');
  symonSessions.delete(sessionId);
  if (owner) void abortSymonSessionCalls(sessionId, owner, 'session_stopped');
  stopAgentSession(sessionId);
  clearSymonScopeGrant(sessionId);
  persistAgentRegistry();
}

function currentSymonOwner(sessionId: string): { route: SymonSessionRoute; client: ClientState } | null {
  const route = symonSessions.get(sessionId);
  if (!route) return null;
  const client = clients.get(route.clientId);
  if (!client) return null;
  const grant = activeSymonGrant(client, sessionId);
  return grant && isSameSymonGrant(route.scope, grant) ? { route, client } : null;
}

async function invokeSymonTool(call: PendingToolCall): Promise<SymonToolRelayResult> {
  try {
    return await fetchNextJson<SymonToolRelayResult>('/api/mobile/symon/tool', {
      method: 'POST',
      body: {
        sessionId: call.sessionId,
        callId: call.callId,
        tool: call.tool,
        // These are the original server-scoped arguments. A confirmation frame
        // carries no args and therefore cannot widen or replace repo scope.
        args: call.args ?? {},
        utterance: call.utterance,
      },
      timeoutMs: symonToolTimeoutMs(call.tool) + 5_000,
    });
  } catch {
    const delivered = await interruptSymonTool(call);
    return delivered
      ? { ok: false, result: { error: 'tool_timeout' } }
      : {
        ok: false,
        result: {
          error: 'interrupt_delivery_failed',
          detail: 'Native cancellation could not be delivered; the action outcome is unknown.',
        },
      };
  }
}

async function resolveSymonConfirmation(
  confirmation: SymonPendingConfirmation,
  allow: boolean,
  terminal?: 'expired' | 'preempted',
): Promise<{ ok: boolean; resolution?: SymonConfirmationResolution }> {
  try {
    return await fetchNextJson('/api/mobile/symon/confirm', {
      method: 'POST',
      body: {
        sessionId: confirmation.sessionId,
        callId: confirmation.callId,
        confirmationId: confirmation.confirmationId,
        allow,
        terminal,
      },
      timeoutMs: 15_000,
    });
  } catch {
    return { ok: false };
  }
}

function publishCompletedSymonToolCall(completed: CompletedToolCall): void {
  const { call, outcome } = completed;
  if (completed.action.status === 'accepted') {
    const repoPath = typeof call.args?.repoPath === 'string' ? call.args.repoPath : '';
    symonAsyncActionTracker.register(completed.action, repoPath, completed.completedAt);
  }
  touchAgentSession(call.sessionId);
  persistAgentRegistry();
  const owner = currentSymonOwner(call.sessionId);
  if (!owner) return;
  pushSymonToolResult(owner.route.clientId, call.sessionId, call.callId, outcome.ok, outcome.result);
  if (owner.route.protocolVersion === 2) {
    pushSymonActionComplete(owner.route.clientId, completed.action);
  }
  if (symonToolTracker.inFlightForSession(call.sessionId) === 0) {
    pushSymonStatus(owner.route.clientId, call.sessionId, 'live');
    if (getAgentSession()?.sessionId === call.sessionId) {
      updateAgentStatus(call.sessionId, 'live');
      persistAgentRegistry();
    }
  }
}

function finishSymonToolCall(call: PendingToolCall, outcome: SymonToolRelayResult): void {
  const completed = symonToolTracker.complete(call.sessionId, call.callId, outcome, Date.now());
  if (completed) publishCompletedSymonToolCall(completed);
}

async function timeoutSymonToolCall(call: PendingToolCall): Promise<void> {
  if (!symonToolTracker.markInterrupting(call.sessionId, call.callId)) return;
  const delivered = await interruptSymonTool(call);
  const completed = symonToolTracker.complete(
    call.sessionId,
    call.callId,
    delivered
      ? { ok: false, result: { error: 'tool_timeout' } }
      : {
        ok: false,
        result: {
          error: 'interrupt_delivery_failed',
          detail: 'Native cancellation could not be delivered; the action outcome is unknown.',
        },
      },
    Date.now(),
  );
  if (!completed) return;
  publishCompletedSymonToolCall(completed);
}

async function resumeSymonToolAfterConfirmation(confirmation: SymonPendingConfirmation): Promise<void> {
  const call = symonToolTracker.markExecuting(confirmation.sessionId, confirmation.callId, Date.now());
  if (!call || !currentSymonOwner(call.sessionId)) return;
  touchAgentSession(call.sessionId);
  persistAgentRegistry();
  const outcome = await invokeSymonTool(call);
  await handleSymonToolOutcome(call, outcome);
}

async function handleSymonToolOutcome(
  call: PendingToolCall,
  outcome: SymonToolRelayResult,
): Promise<void> {
  if (!outcome.confirmation) {
    finishSymonToolCall(call, outcome);
    return;
  }
  const confirmation = outcome.confirmation;
  if (!symonToolTracker.markAwaitingConfirmation(
    call.sessionId,
    call.callId,
    confirmation.confirmationId,
  ) || !symonConfirmationTracker.register(confirmation, Date.now())) {
    finishSymonToolCall(call, {
      ok: false,
      result: { error: 'confirmation_mismatch', detail: 'Confirmation identity collision.' },
    });
    return;
  }

  touchAgentSession(call.sessionId);
  persistAgentRegistry();

  const owner = currentSymonOwner(call.sessionId);
  if (!owner) return;
  pushSymonStatus(owner.route.clientId, call.sessionId, 'acting', 'awaiting approval');
  if (Date.now() >= confirmation.expiresAt) {
    symonConfirmationTracker.claim({
      sessionId: call.sessionId,
      callId: call.callId,
      confirmationId: confirmation.confirmationId,
      allow: false,
      clientMutationId: `expired-deny:${confirmation.confirmationId}`,
      now: Date.now(),
    });
    await settleSymonConfirmationWithRetry({
      confirmation,
      allow: false,
      forcedOutcome: 'expired',
      resume: true,
    });
    return;
  }
  if (call.protocolVersion === 2) {
    pushSymonConfirmRequired(owner.route.clientId, confirmation);
    return;
  }

  // Legacy clients cannot approve on-phone. Every card in a serial chain is
  // denied immediately, including a destructive step that follows an approved
  // aggregate plan card.
  const claim = symonConfirmationTracker.claim({
    sessionId: call.sessionId,
    callId: call.callId,
    confirmationId: confirmation.confirmationId,
    allow: false,
    clientMutationId: `legacy-deny:${confirmation.confirmationId}`,
    now: Date.now(),
  });
  if (claim.kind === 'claimed') {
    await settleSymonConfirmationWithRetry({
      confirmation,
      allow: false,
      forcedOutcome: claim.forcedOutcome,
      resume: true,
    });
  }
}

async function settleSymonConfirmation(input: {
  confirmation: SymonPendingConfirmation;
  allow: boolean;
  forcedOutcome?: 'expired' | 'preempted';
  resume: boolean;
  settleRoute?: SymonConfirmationRoute;
}): Promise<boolean> {
  const response = await resolveSymonConfirmation(
    input.confirmation,
    input.allow,
    input.forcedOutcome,
  );
  const resolvedOutcome = response.ok && response.resolution
    ? confirmationOutcomeFromResolution(response.resolution)
    : null;
  const outcome = resolvedOutcome;
  if (!outcome) {
    symonConfirmationTracker.release(
      input.confirmation.sessionId,
      input.confirmation.callId,
      input.confirmation.confirmationId,
    );
    return false;
  }
  symonConfirmationTracker.settle(
    input.confirmation.sessionId,
    input.confirmation.callId,
    input.confirmation.confirmationId,
    outcome,
    Date.now(),
  );
  const route = input.settleRoute ?? currentSymonOwner(input.confirmation.sessionId)?.route;
  if (route?.protocolVersion === 2) {
    pushSymonConfirmSettled(route.clientId, input.confirmation, outcome);
  }
  if (input.resume) await resumeSymonToolAfterConfirmation(input.confirmation);
  return true;
}

async function settleSymonConfirmationWithRetry(
  input: Parameters<typeof settleSymonConfirmation>[0],
  attempts = 3,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await settleSymonConfirmation(input)) return true;
    if (attempt + 1 < attempts) {
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
    }
  }
  return false;
}

async function denySymonSessionConfirmations(
  sessionId: string,
  route: SymonSessionRoute,
  outcome: 'preempted',
): Promise<void> {
  const confirmations = symonConfirmationTracker.preemptSession(sessionId);
  for (const confirmation of confirmations) {
    // Best-effort immediate denial; the Rust TTL remains the final fail-closed
    // backstop if the webview disappears during teardown.
    await settleSymonConfirmationWithRetry({
      confirmation,
      allow: false,
      forcedOutcome: outcome,
      resume: false,
      settleRoute: route,
    });
  }
}

async function handleSymonConfirmDecision(client: ClientState, msg: Record<string, unknown>): Promise<void> {
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : '';
  const callId = typeof msg.callId === 'string' ? msg.callId : '';
  const confirmationId = typeof msg.confirmationId === 'string' ? msg.confirmationId : '';
  const clientMutationId = typeof msg.clientMutationId === 'string' ? msg.clientMutationId : '';
  const allow = typeof msg.allow === 'boolean' ? msg.allow : null;
  if (!sessionId || !callId || !confirmationId || !clientMutationId || allow === null) return;

  const textSession = loadSymonTextSession(sessionId);
  const textOwner = symonTextOwners.get(sessionId);
  if (textSession && textOwner === client.id && symonTextClientMatches(textSession, client)) {
    const claim = symonConfirmationTracker.claim({
      sessionId,
      callId,
      confirmationId,
      allow,
      clientMutationId,
      now: Date.now(),
    });
    if (claim.kind === 'missing') return;
    if (claim.kind === 'in_flight') {
      pushSymonConfirmSettled(client.id, claim.confirmation, 'duplicate');
      return;
    }
    if (claim.kind === 'replay') {
      pushSymonConfirmSettled(client.id, claim.confirmation, 'duplicate', claim.outcome);
      return;
    }
    await settleSymonConfirmationWithRetry({
      confirmation: claim.confirmation,
      allow: claim.allow,
      forcedOutcome: claim.forcedOutcome,
      resume: false,
      settleRoute: { clientId: client.id, protocolVersion: 2 },
    });
    return;
  }

  const route = symonSessions.get(sessionId);
  const grant = activeSymonGrant(client, sessionId);
  if (!route || route.protocolVersion !== 2 || route.clientId !== client.id
    || !grant || !isSameSymonGrant(route.scope, grant)) return;
  touchAgentSession(sessionId);
  persistAgentRegistry();

  const claim = symonConfirmationTracker.claim({
    sessionId,
    callId,
    confirmationId,
    allow,
    clientMutationId,
    now: Date.now(),
  });
  if (claim.kind === 'missing') return;
  if (claim.kind === 'in_flight') {
    pushSymonConfirmSettled(route.clientId, claim.confirmation, 'duplicate');
    return;
  }
  if (claim.kind === 'replay') {
    pushSymonConfirmSettled(route.clientId, claim.confirmation, 'duplicate', claim.outcome);
    const replay = symonToolTracker.replay(sessionId, callId, Date.now());
    if (replay) {
      pushSymonToolResult(route.clientId, sessionId, callId, replay.outcome.ok, replay.outcome.result);
      pushSymonActionComplete(route.clientId, replay.action);
    }
    return;
  }

  await settleSymonConfirmationWithRetry({
    confirmation: claim.confirmation,
    allow: claim.allow,
    forcedOutcome: claim.forcedOutcome,
    resume: true,
  });
}

async function handleSymonToolInterrupt(client: ClientState, msg: Record<string, unknown>): Promise<void> {
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : '';
  const callId = typeof msg.callId === 'string' ? msg.callId : '';
  if (!sessionId || !callId) return;
  const route = symonSessions.get(sessionId);
  const grant = activeSymonGrant(client, sessionId);
  if (!route || route.protocolVersion !== 2 || route.clientId !== client.id
    || !grant || !isSameSymonGrant(route.scope, grant)) return;
  const call = symonToolTracker.get(sessionId, callId);
  if (!call) return;
  touchAgentSession(sessionId);
  persistAgentRegistry();
  const delivered = await interruptSymonTool(call);
  if (!delivered) {
    finishSymonToolCall(call, {
      ok: false,
      result: {
        error: 'interrupt_delivery_failed',
        detail: 'Native cancellation could not be delivered; the action outcome is unknown.',
      },
    });
    return;
  }
  const preemptedConfirmations = symonConfirmationTracker.preemptCall(sessionId, callId);
  for (const confirmation of preemptedConfirmations) {
    symonConfirmationTracker.settle(
      sessionId,
      callId,
      confirmation.confirmationId,
      'preempted',
      Date.now(),
    );
    pushSymonConfirmSettled(route.clientId, confirmation, 'preempted');
  }
  // Complete every authenticated exact interrupt, even if it beat the
  // confirmation mirror registration. A late route outcome is then an
  // idempotent no-op against this replayable tombstone.
  finishSymonToolCall(call, { ok: false, result: { error: 'session_preempted' } });
}

async function handleSymonToolCall(client: ClientState, msg: Record<string, unknown>): Promise<void> {
  const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : '';
  const callId = typeof msg.callId === 'string' ? msg.callId : '';
  const tool = typeof msg.tool === 'string' ? msg.tool : '';
  const args = msg.args && typeof msg.args === 'object' ? (msg.args as Record<string, unknown>) : {};
  const utterance = typeof msg.utterance === 'string'
    ? msg.utterance.trim().slice(0, 8_000)
    : '';
  if (!sessionId || !callId || !tool) return;
  const grant = activeSymonGrant(client, sessionId);
  if (!grant) {
    pushSymonToolResult(client.id, sessionId, callId, false, {
      error: 'session_scope_invalid',
      detail: 'This Symon session does not have an active scope grant for this phone.',
    });
    return;
  }
  const scoped = scopeSymonToolArgs(grant, tool, args);
  if (!scoped.ok) {
    pushSymonToolResult(client.id, sessionId, callId, false, {
      error: scoped.error,
      detail: scoped.detail,
    });
    return;
  }

  const requestedProtocol = symonProtocolVersion(msg);
  const existingOwner = symonSessions.get(sessionId);
  const protocolVersion = existingOwner?.protocolVersion === 2 ? 2 : requestedProtocol;
  if (!existingOwner) {
    symonSessions.set(sessionId, { clientId: client.id, scope: grant, protocolVersion });
    startAgentSession(sessionId);
    preemptOtherSymonSessions(sessionId, 'preempted');
  } else if (existingOwner.clientId !== client.id || !isSameSymonGrant(existingOwner.scope, grant)
    || existingOwner.protocolVersion !== protocolVersion) {
    if (existingOwner.clientId !== client.id || !isSameSymonGrant(existingOwner.scope, grant)) {
      void denySymonSessionConfirmations(sessionId, existingOwner, 'preempted');
      void abortSymonSessionCalls(sessionId, existingOwner, 'session_preempted');
      pushSymonStatus(existingOwner.clientId, sessionId, 'idle', 'preempted');
    }
    symonSessions.set(sessionId, { clientId: client.id, scope: grant, protocolVersion });
  }
  touchAgentSession(sessionId);
  persistAgentRegistry();

  const replay = symonToolTracker.replay(sessionId, callId, Date.now());
  if (replay) {
    if (replay.call.tool !== tool) {
      pushSymonToolResult(client.id, sessionId, callId, false, {
        error: 'call_mismatch',
        detail: 'This sessionId and callId are already bound to another tool.',
      });
      return;
    }
    pushSymonToolResult(client.id, sessionId, callId, replay.outcome.ok, replay.outcome.result);
    if (protocolVersion === 2) pushSymonActionComplete(client.id, replay.action);
    return;
  }
  const activeCall = symonToolTracker.get(sessionId, callId);
  if (activeCall) {
    if (activeCall.tool !== tool) {
      pushSymonToolResult(client.id, sessionId, callId, false, {
        error: 'call_mismatch',
        detail: 'This sessionId and callId are already bound to another tool.',
      });
      return;
    }
    if (protocolVersion === 2 && activeCall.confirmationId) {
      const pending = symonConfirmationTracker.get(sessionId, callId, activeCall.confirmationId);
      if (pending) pushSymonConfirmRequired(client.id, pending);
    }
    return;
  }
  const call: PendingToolCall = {
    sessionId,
    callId,
    tool,
    // Correlation stays on the server-owned call record. The native execution
    // seam injects it only into o8_delegate's final dispatch args, after any
    // immutable plan has been validated and approved.
    args: scoped.args,
    utterance: utterance || undefined,
    protocolVersion,
    startedAt: Date.now(),
  };
  if (!symonToolTracker.add(call)) return;
  pushSymonStatus(client.id, sessionId, 'acting');

  const outcome = await invokeSymonTool(call);
  await handleSymonToolOutcome(call, outcome);
}

/** Disconnect cleanup — drop any symon sessions this socket owned. */
function cleanupSymonForClient(clientId: string): void {
  for (const [sessionId, ownerId] of Array.from(symonTextOwners.entries())) {
    if (ownerId !== clientId) continue;
    symonTextOwners.delete(sessionId);
    for (const turn of symonTextTurns.values()) {
      if (turn.sessionId !== sessionId || turn.terminal) continue;
      void interruptSymonTextNative(turn.sessionId, turn.turnId);
      pushSymonTextDone(turn, 'interrupted');
    }
  }
  let changed = false;
  for (const [sid, route] of Array.from(symonSessions.entries())) {
    if (route.clientId !== clientId) continue;
    void denySymonSessionConfirmations(sid, route, 'preempted');
    symonSessions.delete(sid);
    void abortSymonSessionCalls(sid, route, 'session_stopped');
    stopAgentSession(sid);
    clearSymonScopeGrant(sid);
    changed = true;
  }
  if (changed) persistAgentRegistry();
}

/**
 * Stale sweep — an agent session with no status event or tool call for 10 min is
 * marked idle + dropped (contract §"Session registry"). Also interrupts and
 * reaps any tool call that outlived its tool-aware execution budget.
 */
function sweepStaleSymon(): void {
  symonAsyncActionTracker.prune(Date.now());
  const dropped = sweepStaleAgentSession();
  if (dropped) {
    const route = symonSessions.get(dropped.sessionId);
    if (route) {
      void denySymonSessionConfirmations(dropped.sessionId, route, 'preempted');
      void abortSymonSessionCalls(dropped.sessionId, route, 'session_stopped');
      pushSymonStatus(route.clientId, dropped.sessionId, 'idle', 'stale');
    }
    symonSessions.delete(dropped.sessionId);
    clearSymonScopeGrant(dropped.sessionId);
    persistAgentRegistry();
  }
  for (const call of symonToolTracker.timedOut(Date.now())) {
    void timeoutSymonToolCall(call);
  }
  for (const confirmation of symonConfirmationTracker.expire(Date.now())) {
    const textOwner = symonTextOwners.get(confirmation.sessionId);
    void settleSymonConfirmationWithRetry({
      confirmation,
      allow: false,
      forcedOutcome: 'expired',
      resume: currentSymonOwner(confirmation.sessionId) !== null,
      ...(textOwner ? { settleRoute: { clientId: textOwner, protocolVersion: 2 as const } } : {}),
    });
  }
}

/**
 * Lazy DESK preemption (Case B, contract §"Mutual exclusion"). A desk-mic session
 * started by in-app double-tap never passes through our routes; detect it here on
 * a ≤5s cadence by reading the desk status (GET /api/mobile/symon → __o8RealtimeStatus)
 * and, if it went live while a phone agent session is active, push idle to the phone.
 */
async function sweepDeskPreemption(): Promise<void> {
  if (symonSessions.size === 0) return;
  let deskStatus = 'idle';
  try {
    const snap = await fetchNextJson<{ status?: string }>('/api/mobile/symon');
    deskStatus = typeof snap.status === 'string' ? snap.status : 'idle';
  } catch {
    return; // bridge hiccup — try again next tick
  }
  const deskLive = deskStatus === 'live' || deskStatus === 'connecting' || deskStatus === 'requesting-mic';
  if (!deskLive) return;
  for (const [sid, route] of Array.from(symonSessions.entries())) {
    void denySymonSessionConfirmations(sid, route, 'preempted');
    void abortSymonSessionCalls(sid, route, 'session_preempted');
    pushSymonStatus(route.clientId, sid, 'idle', 'preempted_by_desk');
    symonSessions.delete(sid);
    clearSymonScopeGrant(sid);
  }
  stopAgentSession();
  persistAgentRegistry();
}

setInterval(sweepStaleSymon, 30_000);
setInterval(() => { void sweepDeskPreemption(); }, 3_000);

// ── Orchestrator channel handlers ──

function handleOrchestratorUnsubscribe(client: ClientState, msg: Record<string, unknown>) {
  // With `backend` + `agent`, drop just that one surface's subscription; with
  // `backend` alone, drop every subscription for that backend; without either
  // (legacy clients) drop every subscription for this client.
  const raw = msg.backend;
  if (!isOrchestratorBackendId(raw)) {
    for (const key of orchestratorSubscriptions.keys()) {
      if (key.startsWith(`${client.id}::`)) orchestratorSubscriptions.delete(key);
    }
    return;
  }
  const agent = resolveMsgAgentId(msg, raw);
  if (agent) {
    orchestratorSubscriptions.delete(orchestratorSubKey(client.id, raw, agent));
  } else {
    // No specific agent — drop every subscription for this backend.
    const prefix = `${client.id}::${raw}::`;
    for (const key of orchestratorSubscriptions.keys()) {
      if (key.startsWith(prefix)) orchestratorSubscriptions.delete(key);
    }
  }
}

async function handleOrchestratorSubscribe(client: ClientState, msg: Record<string, unknown>) {
  const repoPath = resolveOrchestratorMessageRepoPath(msg);
  if (!repoPath) return;

  const requestedBackendId = resolveMsgBackendId(msg);
  const threadId = resolveMsgThreadId(msg);
  const activeRoute = activeOrchestratorRoutes.resolve({ repoPath, threadId, requestedBackend: requestedBackendId });
  const backend = getOrchestratorBackend(activeRoute?.toBackend ?? requestedBackendId);
  const agentId = activeRoute ? '' : resolveMsgAgentId(msg, backend.id);
  const agentTag = agentId || undefined;
  // Replay cursor: the highest event seq this client has already seen for the
  // session. Replay is OPT-IN — only clients that send `since` (and de-dup by
  // seq, like the desktop orchestrator) get a backfill; canvas/mobile omit it
  // and keep their existing no-replay behavior. since=0 means "I've seen
  // nothing — replay the whole in-flight turn." See lib/orchestrator/replay-buffer.
  const hasSince = typeof msg.since === 'number' && Number.isFinite(msg.since);
  const since = hasSince ? (msg.since as number) : 0;

  try {
    const session = backend.ensureSession(repoPath, agentTag, threadId);
    const routeSessionName = activeRoute?.toSessionName
      ?? orchestratorRouteSessionName(session.sessionName, threadId);
    orchestratorSubscriptions.set(orchestratorSubKey(client.id, backend.id, agentId), {
      clientId: client.id,
      repoPath,
      sessionName: routeSessionName,
      threadId,
      backend: backend.id,
      agent: agentId,
    });
    if (backend.id === 'openclaw') {
      console.log(`[openclaw-diag] subscribe key=${orchestratorSubKey(client.id, backend.id, agentId)} sessionName=${session.sessionName}`);
    }

    // No PTY to hook — the new approach spawns a process per message
    // and streams structured JSON events directly to WS subscribers.
    //
    // Heal a STALE 'busy' snapshot: if the session claims busy but we haven't
    // broadcast any live event for it in > ORCH_SNAPSHOT_STALE_MS, the turn's
    // child wedged/died without flipping back to 'ready' (the case the live
    // stream-resolve fix can't catch — the await never returns). Reporting the
    // real 'busy' would restore a phantom "Working" timer on this reload that
    // counts up forever. Report 'ready' instead; we do NOT mutate the session,
    // so a genuinely-resuming turn still streams normally. (2026-06-22)
    const lastActivityAt = lastOrchestratorActivityAt.get(routeSessionName) ?? 0;
    const snapshotStatus = session.status === 'busy'
      && Date.now() - lastActivityAt > ORCH_SNAPSHOT_STALE_MS
        ? 'ready'
        : session.status;

    // Task #8 — server turn truth rides every (re)subscribe snapshot. The
    // newest ledger record for this thread lets the client reconcile against
    // reality instead of elapsed-silence heuristics: a running timer with no
    // active ledger turn is a phantom (clear it); a settled turn whose
    // assistantMessageId is missing from the visible transcript means the
    // live buffer lost a persisted turn (refetch, don't replace).
    let turn: Record<string, unknown> | null = null;
    if (threadId) {
      try {
        const { listOrchestratorTurnsForThread } = await import('@/lib/lane/orchestrator-crash-survival');
        const latest = listOrchestratorTurnsForThread(threadId)[0];
        if (latest) {
          turn = {
            id: latest.id,
            startedAt: latest.startedAt,
            settledAt: latest.settledAt ?? null,
            outcome: latest.outcome ?? null,
            assistantMessageId: latest.assistantMessageId ?? null,
          };
        }
      } catch { /* ledger read is best-effort — snapshot still ships */ }
    }

    send(client, {
      channel: 'orchestrator',
      event: 'status',
      // `snapshot: true` marks this as a point-in-time resync of the session
      // status on (re)subscribe — NOT a live turn transition. The client must
      // not let it downgrade or finalize an in-flight turn (see socket.ts):
      // the first-turn threadId mint forces a mid-turn re-subscribe, and a
      // snapshot 'ready' landing right after the client set 'busy' is exactly
      // what silently killed first-turn streaming until a reload.
      data: { status: snapshotStatus, snapshot: true, repoPath, sessionName: routeSessionName, threadId, backend: backend.id, agent: agentTag, turn },
    });

    // Replay anything this client missed on the in-flight turn (reload /
    // reconnect / the first-turn threadId-mint re-subscribe). Opt-in via
    // `since`. The subscription was registered just above and this handler body
    // runs synchronously, so no live broadcast can interleave between the
    // snapshot and this replay.
    if (hasSince) {
      const replay = orchestratorReplay.since(routeSessionName, since);
      for (const raw of replay) sendRaw(client, raw);
      if (replay.length) {
        console.log(`[ws-server] Replayed ${replay.length} orchestrator events to ${client.id} (since=${since}, ${backend.id}${threadId ? ` thread ${threadId}` : ''})`);
      }
    }

    // Latest-plan recovery for cursor-less clients (mobile omits `since`): if
    // a turn is genuinely live, re-send its newest plan snapshot so the plan
    // card survives a reconnect. Gated on the HEALED status — a stale busy
    // must not resurrect a dead turn's plan (the client treats plan-update as
    // "turn is busy"). Sent after the seq replay so latest always wins.
    if (snapshotStatus === 'busy') {
      const planData = latestOrchestratorPlanBySession.get(routeSessionName);
      if (planData) {
        send(client, { channel: 'orchestrator', event: 'plan-update', data: { ...planData, snapshot: true } });
      }
    }
    console.log(`[ws-server] Client ${client.id} subscribed to orchestrator (${backend.id}${agentId ? `/${agentId}` : ''}${threadId ? ` thread ${threadId}` : ''}) for ${repoPath}`);
  } catch (err) {
    send(client, {
      channel: 'orchestrator',
      event: 'error',
      data: { error: err instanceof Error ? err.message : 'Failed to start orchestrator session', repoPath, threadId, backend: backend.id, agent: agentTag },
    });
  }
}

const ORCHESTRATOR_SEND_IDEMPOTENCY_VERB = 'orchestrator-send';
// A governed turn may legitimately run far longer than the generic store's
// ten-minute default. Keep its reservation alive for a full operator day so a
// reconnect/retry cannot fork the same command while the original is working.
const ORCHESTRATOR_SEND_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

class OrchestratorSendRejectedBeforeAcceptance extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Orchestrator command was not accepted');
    this.name = 'OrchestratorSendRejectedBeforeAcceptance';
  }
}

function sendOrchestratorSendAck(client: ClientState, input: {
  repoPath: string;
  threadId: string | null;
  backend: OrchestratorBackendId;
  agent?: string;
  correlationId?: string;
  state: OrchestratorSendAckState;
  duplicate: boolean;
}) {
  send(client, {
    channel: 'orchestrator',
    event: 'send-ack',
    data: {
      repoPath: input.repoPath,
      threadId: input.threadId,
      backend: input.backend,
      agent: input.agent,
      ...orchestratorCommandAckCorrelation(input.correlationId),
      state: input.state,
      duplicate: input.duplicate,
    },
  });
}

function sendOrchestratorInterruptAck(client: ClientState, input: {
  repoPath: string;
  threadId: string | null;
  backend: OrchestratorBackendId;
  agent?: string;
  correlationId?: string;
  state: OrchestratorInterruptAckState;
  interrupted: boolean;
  duplicate: boolean;
  note?: string;
}) {
  send(client, {
    channel: 'orchestrator',
    event: 'interrupt-ack',
    data: {
      repoPath: input.repoPath,
      threadId: input.threadId,
      backend: input.backend,
      agent: input.agent,
      ...orchestratorCommandAckCorrelation(input.correlationId),
      state: input.state,
      interrupted: input.interrupted,
      duplicate: input.duplicate,
      note: input.note,
    },
  });
}

async function handleOrchestratorSendMsg(client: ClientState, msg: Record<string, unknown>) {
  const repoPath = resolveOrchestratorMessageRepoPath(msg);
  const message = typeof msg.message === 'string' ? msg.message : null;
  if (!repoPath || !message) return;

  const correlationId = resolveOrchestratorCommandCorrelationId(msg);
  // Legacy clients did not send a correlation id. Preserve their exact
  // execution behavior; the one-shot handler still emits an uncorrelated
  // accepted ACK at the later, truthful acceptance point.
  if (!correlationId) {
    await handleOrchestratorSendMsgOnce(client, msg, undefined);
    return;
  }

  const requestedBackendId = resolveMsgBackendId(msg);
  const backendId = resolveOrchestratorExecutionBackendId(requestedBackendId, msg.orchestrationMode);
  const agentId = backendId === requestedBackendId ? resolveMsgAgentId(msg, backendId) : '';
  const threadId = resolveMsgThreadId(msg);
  const scopeId = orchestratorSendIdempotencyScope({
    repoPath,
    backend: backendId,
    agent: agentId,
    threadId,
  });
  const key = deriveIdempotencyKey({
    verb: ORCHESTRATOR_SEND_IDEMPOTENCY_VERB,
    scopeId,
    clientKey: correlationId,
  });

  try {
    const outcome = await withIdempotency<void>({
      key,
      verb: ORCHESTRATOR_SEND_IDEMPOTENCY_VERB,
      scopeId,
      ttlMs: ORCHESTRATOR_SEND_IDEMPOTENCY_TTL_MS,
    }, async () => {
      await handleOrchestratorSendMsgOnce(client, msg, correlationId);
    });

    // The first caller receives `accepted` from inside the reserved execution,
    // after the turn is durably owned. A duplicate never re-enters that body,
    // so acknowledge its exact disposition here instead.
    if (outcome.replayed) {
      const duplicateAck = duplicateOrchestratorSendAck(outcome.inProgress);
      sendOrchestratorSendAck(client, {
        repoPath,
        threadId,
        backend: backendId,
        agent: agentId || undefined,
        correlationId,
        ...duplicateAck,
      });
    }
  } catch (error) {
    if (error instanceof OrchestratorSendRejectedBeforeAcceptance) return;
    // A keyed command fails closed when its durable reservation cannot be
    // established. Executing without the guard would make a retry capable of
    // starting a second governed turn.
    send(client, {
      channel: 'orchestrator',
      event: 'error',
      data: {
        error: error instanceof Error ? error.message : 'Failed to reserve orchestrator command',
        repoPath,
        threadId,
        backend: backendId,
        agent: agentId || undefined,
        ...orchestratorCommandAckCorrelation(correlationId),
      },
    });
  }
}

async function handleOrchestratorSendMsgOnce(
  client: ClientState,
  msg: Record<string, unknown>,
  correlationId: string | undefined,
) {
  const repoPath = resolveOrchestratorMessageRepoPath(msg);
  const message = typeof msg.message === 'string' ? msg.message : null;
  if (!repoPath || !message) return;
  // The transcript persists the operator's OWN words. `message` may carry
  // model-facing scaffolding the client prepends (mode directives, compaction
  // resume prelude) — persisting it verbatim rendered those directives
  // as a user bubble after reload (Chris's screenshot, 2026-07-16). Older
  // clients may omit the field, so the persistence seam also recognizes and
  // removes only o8's exact composer preambles.
  const transcriptMessage = resolveOrchestratorTranscriptMessage({
    message,
    displayMessage: msg.displayMessage,
  });

  // Permission mode travels with the user message. Defaults to 'full' to
  // match legacy behavior for clients that haven't been updated yet.
  const permissionMode: 'full' | 'plan' =
    msg.permissionMode === 'plan' ? 'plan' : 'full';
  const thinkingEffort: ManualThinkingEffort | undefined = isManualThinkingEffort(msg.thinkingEffort)
    ? msg.thinkingEffort
    : undefined;
  const model = typeof msg.model === 'string' && msg.model.trim()
    ? msg.model.trim()
    : undefined;
  const crossHouseRole = msg.surface === 'canvas-agent' ? 'canvas-agent' : 'orchestrator';
  // Composer picture pills — validated data URIs only, capped so one send
  // can't balloon the stdin payload (8 images, ~5MB base64 each).
  const attachments = Array.isArray(msg.attachments)
    ? (msg.attachments as Array<{ dataUri?: unknown; name?: unknown }>)
        .filter((att): att is { dataUri: string; name?: string } =>
          typeof att?.dataUri === 'string'
          && /^data:image\/[a-z+.-]+;base64,/i.test(att.dataUri)
          && att.dataUri.length < 5_000_000)
        .slice(0, 8)
        .map((att) => ({ dataUri: att.dataUri, ...(typeof att.name === 'string' ? { name: att.name } : {}) }))
    : undefined;

  const requestedBackendId = resolveMsgBackendId(msg);
  const requestedBackend = getOrchestratorBackend(requestedBackendId);
  const executionBackendId = resolveOrchestratorExecutionBackendId(requestedBackendId, msg.orchestrationMode);
  let activeBackend = getOrchestratorBackend(executionBackendId);
  const subscriptionProfile = getOperatorDefaultsSync().values.subscriptionProfile;
  const collideBaseBackend = requestedBackend.id === 'collide' && isOrchestratorBackendId(msg.collideBaseBackend)
    ? msg.collideBaseBackend
    : undefined;
  const requestedAgentId = executionBackendId === requestedBackendId
    ? resolveMsgAgentId(msg, requestedBackend.id)
    : '';
  let activeAgentId = requestedAgentId;
  let activeAgentTag = activeAgentId || undefined;
  const threadId = resolveMsgThreadId(msg);
  let abortKey = orchestratorAbortKey(repoPath, activeBackend.id, activeAgentId, threadId);
  const turnAbortKeys = new Set<string>([abortKey]);

  // #624 — Declared outside try so the catch can also release the entry.
  let turnController: AbortController | null = null;
  let activeRouteHandle: ActiveOrchestratorRouteHandle | null = null;
  let commandAccepted = false;
  // Declared outside try so the catch can broadcast the terminal error to EVERY
  // subscriber on this thread (phone + desktop), not just the origin client. A
  // phone-started turn that threw used to leave the desktop latched at "busy"
  // forever because the error went only to the sender. (2026-06-22 latch audit)
  let sessionName: string | null = null;

  // Durable assistant persistence for canonical thoughts-* threads. Even if
  // the mobile preview sheet closes or no full /chat client is open, the
  // streamed assistant text is appended to ~/.o8/chat-history/<thread>.json
  // so the next list/restore sees it. Stable messageId across deltas means
  // a later client POST that replaces the array can't double-write.
  const isThreadBacked = typeof threadId === 'string' && threadId.startsWith('thoughts-');
  const turnStartedAtMs = Date.now();
  const userMessageId = correlationId
    ? `orch-user-${correlationId}`
    : `user-${turnStartedAtMs}`;
  const assistantMessageId = isThreadBacked ? `assistant-${turnStartedAtMs}` : null;
  const assistantStartedAtMs = turnStartedAtMs;
  let assistantTextAccum = '';
  let lastPersistedAssistantText = '';
  // Incremental persistence (2026-06-22): persist the streamed assistant text
  // every ~1.5s WHILE the turn runs, not only at terminal points. Without this,
  // a turn whose child wedges (never emits 'done', the await never resolves)
  // loses its entire streamed reply on the next reload — the transcript drops
  // back to just the user messages (operator-observed data loss). Throttled so
  // a fast token stream doesn't hammer the chat-history file + threads broadcast.
  let lastIncrementalPersistAt = 0;
  const INCREMENTAL_PERSIST_MS = 1_500;

  const persistAssistantText = (sessionId: string | null, backendId: OrchestratorBackendId = activeBackend.id) => {
    if (!isThreadBacked || !assistantMessageId) return;
    if (undoneOrchestratorUserMessageIds.has(userMessageId)) return;
    if (!assistantTextAccum || assistantTextAccum === lastPersistedAssistantText) return;
    try {
      const updatedThread = upsertMobileOrchestratorAssistantMessage({
        tabId: threadId,
        repoPath,
        messageId: assistantMessageId,
        content: assistantTextAccum,
        backend: backendId,
        agent: activeAgentTag,
        sessionId,
        model: model ?? null,
        timestampMs: assistantStartedAtMs,
      });
      lastPersistedAssistantText = assistantTextAccum;
      if (updatedThread) {
        broadcast({
          channel: 'orchestrator-threads',
          event: 'upsert',
          data: { thread: updatedThread },
        });
      }
    } catch (err) {
      console.warn('[ws-server][orchestrator] failed to persist assistant message', err);
    }
  };

  try {
    console.log(`[ws-server][orchestrator] Routing chat via ${activeBackend.label}${activeAgentId ? ` (agent ${activeAgentId})` : ''}`);

    sessionName = orchestratorRouteSessionName(
      activeBackend.ensureSession(repoPath, activeAgentTag, threadId).sessionName,
      threadId,
    );
    // RC2 (69RMXR) — auto-carry prior transcript when the operator switched to a
    // backend that has no CLI session on this thread yet. Computed BEFORE the
    // current user message is persisted so it reflects PRIOR history only; folded
    // into the outbound payload alone (the persisted transcript keeps raw message).
    const carryPrelude = buildBackendSwitchCarryPrelude({ threadId, backend: activeBackend.id });
    if (carryPrelude) {
      console.log(`[backend-switch-carry] Injected prior transcript into first ${activeBackend.id} turn (thread=${threadId ?? 'none'})`);
    }
    // The undo can arrive while backend/session setup is still resolving. In
    // that case the client already restored the draft and there is no turn to
    // start or persist.
    if (undoneOrchestratorUserMessageIds.has(userMessageId)) return;
    const updatedThread = persistOrchestratorThreadUserMessageFromWire({
      message: msg,
      tabId: threadId,
      repoPath,
      transcriptMessage,
      messageId: userMessageId,
      backend: activeBackend.id,
      agent: activeAgentTag,
      timestampMs: turnStartedAtMs,
    });
    if (updatedThread) {
      broadcast({
        channel: 'orchestrator-threads',
        event: 'upsert',
        data: { thread: updatedThread },
      });
      broadcast({
        channel: 'orchestrator-threads',
        event: 'reveal',
        data: { requestedAt: updatedThread.lastMessageAt, thread: updatedThread },
      });
    }
    // #1329 — pin active session rules into EVERY orchestrator turn (not sent
    // once), so they survive context churn + compaction. The RAW `message` is
    // what got persisted to the transcript above; only the payload handed to
    // the backend carries the "Operator session rules (binding)" block. Applies
    // across ALL backends because they all forward this argument untouched.
    const turnBody = carryPrelude ? `${carryPrelude}\n\n${message}` : message;
    const turnMessage = withSessionRules(turnBody, threadId);
    if (turnMessage !== message) {
      console.log(`[session-rules] Injected session rules into orchestrator turn (thread=${threadId ?? 'none'})`);
    }
    // Fable Slice 6 #2 — server-side metered-window valve. The 15K auto-compact
    // target lives in the desktop client's React effect; a headless or mobile
    // operator never mounts it, so a metered window could grow unbounded at
    // full API price. This valve does NOT force-compact (recycling a live proc
    // mid-mission is the client's call) — it warns loudly and raises the UI
    // notice banner each time the persisted thread crosses another 60K-token
    // step past the metered target.
    if (threadId && isMeteredOrchestratorBackend(activeBackend.id)) {
      const approxThreadTokens = await estimateThreadTokens(threadId);
      const step = Math.floor(approxThreadTokens / METERED_WINDOW_VALVE_STEP_TOKENS);
      if (step >= 1 && (meteredWindowValveWarnedStep.get(threadId) ?? 0) < step) {
        meteredWindowValveWarnedStep.set(threadId, step);
        const valveMessage = `Metered window over budget: this thread is ~${Math.round(approxThreadTokens / 1000)}K tokens against a ${Math.round(ORCHESTRATOR_METERED_AUTO_COMPACT_THRESHOLD / 1000)}K target — open the workspace to compact, or start a fresh thread.`;
        console.warn(`[metered-valve] ${valveMessage} (thread=${threadId}, backend=${activeBackend.id})`);
        broadcastToOrchestratorSession(sessionName, JSON.stringify({
          channel: 'orchestrator',
          event: 'notice',
          data: { repoPath, kind: 'metered-window-over-budget', noticeId: `metered-valve-${threadId}-${step}`, message: valveMessage },
        }));
      }
    }
    if (undoneOrchestratorUserMessageIds.has(userMessageId)) return;
    const sendTurn = (
      turnBackend: OrchestratorBackend,
      turnAgentTag: string | undefined,
      onEvent: (event: OrchestratorEvent) => void,
      signal: AbortSignal,
      overrideModel?: string,
    ): Promise<void> => {
      const effectiveModel = overrideModel ?? (turnBackend.id === 'codex' && turnBackend.id !== requestedBackend.id ? undefined : model);
      return sendOrchestratorBackendTurn(turnBackend, repoPath, turnMessage, onEvent, {
        permissionMode,
        thinkingEffort,
        model: effectiveModel,
        collideBaseBackend: turnBackend.id === 'collide' ? collideBaseBackend : undefined,
        agent: turnAgentTag,
        threadId,
        signal,
        ...((turnBackend.id === 'claude' || turnBackend.id === 'codex') ? {
          crashSurvival: {
            backend: turnBackend.id,
            threadId,
            assistantMessageId,
            assistantStartedAtMs,
            model: effectiveModel ?? null,
          },
        } : {}),
        ...(attachments?.length ? { attachments } : {}),
      }, msg.orchestrationMode);
    };

    // Ensure a subscription exists for the selected backend + agent.
    orchestratorSubscriptions.set(orchestratorSubKey(client.id, activeBackend.id, activeAgentId), {
      clientId: client.id,
      repoPath,
      sessionName,
      threadId,
      backend: activeBackend.id,
      agent: activeAgentId,
    });
    if (activeBackend.id === 'openclaw') {
      console.log(`[openclaw-diag] send key=${orchestratorSubKey(client.id, activeBackend.id, activeAgentId)} sessionName=${sessionName} clientId=${client.id}`);
    }

    // #624 — Attach an AbortController for this turn. Defensively abort any
    // prior entry for the same repo+backend+agent so a stale subprocess never
    // outlives a fresh send.
    const priorController = orchestratorInflightAborts.get(abortKey);
    if (priorController && !priorController.signal.aborted) {
      priorController.abort();
    }
    turnController = new AbortController();
    orchestratorInflightAborts.set(abortKey, turnController);

    // Receipt is not acceptance. Only ACK after the route is subscribed, the
    // canonical user message has been persisted (for thoughts-* threads), and
    // the in-flight controller owns this turn. For keyed clients the outer
    // withIdempotency call has also durably reserved the command by this point.
    commandAccepted = true;
    sendOrchestratorSendAck(client, {
      repoPath,
      threadId,
      backend: activeBackend.id,
      agent: activeAgentTag,
      correlationId,
      state: 'accepted',
      duplicate: false,
    });

    // Live activity follows the acceptance ACK on the same ordered socket.
    // Older clients may use this busy event as their delivery fallback, so it
    // must never precede durable command ownership.
    broadcastToOrchestratorSession(sessionName, JSON.stringify({
      channel: 'orchestrator',
      event: 'status',
      data: { status: 'busy', repoPath, threadId, backend: activeBackend.id, agent: activeAgentTag },
    }));

    // Track whether the backend stream delivered a terminal event. If it
    // resolves without one (a hung claude/codex child that never closes, so no
    // 'done' fires), we synthesize a 'ready' below — otherwise the client latch
    // ("Working M:SS") counts up until the 4-hour process reaper or the 5-min
    // client watchdog. (2026-06-22 latch audit)
    let sawTerminal = false;

    let quotaFallbackError: string | null = null;
    const runBackendTurn = async (
      turnBackend: OrchestratorBackend,
      turnAgentTag: string | undefined,
      suppressQuotaError: boolean,
      overrideModel?: string,
    ) => {
      let pendingDone: Extract<OrchestratorEvent, { type: 'done' }> | null = null;
      const emitDone = (event: Extract<OrchestratorEvent, { type: 'done' }>) => {
        sawTerminal = true;
        if (threadId && event.sessionId && (turnBackend.id === 'claude' || turnBackend.id === 'codex')) {
          writeOrchestratorBackendSessionId(threadId, turnBackend.id, event.sessionId);
        }
        persistAssistantText(event.sessionId ?? null, turnBackend.id);
        if (sessionName) {
          broadcastToOrchestratorSession(sessionName, JSON.stringify({
            channel: 'orchestrator',
            event: 'status',
            data: { status: 'ready', repoPath, threadId, sessionId: event.sessionId, cost: event.cost, backend: turnBackend.id, agent: turnAgentTag },
          }));
        }
      };
      await sendTurn(turnBackend, turnAgentTag, (event) => {
        if (turnBackend.id === 'openclaw') {
          const detail = event.type === 'text'
            ? ` textLen=${event.text.length}`
            : event.type === 'error'
              ? ` err=${String(event.error).slice(0, 120)}`
              : '';
          console.log(`[openclaw-diag] ws recv event=${event.type}${detail}`);
        }
        let wsMsg: string | null = null;

        switch (event.type) {
          case 'text':
            if (isThreadBacked) {
              assistantTextAccum += event.text;
              // Throttled mid-stream persist so a wedged turn's reply survives a
              // reload instead of dropping to user-only on disk.
              if (Date.now() - lastIncrementalPersistAt > INCREMENTAL_PERSIST_MS) {
                lastIncrementalPersistAt = Date.now();
                persistAssistantText(null, turnBackend.id);
              }
            }
            wsMsg = JSON.stringify({
              channel: 'orchestrator',
              event: 'output',
              data: { text: event.text, repoPath, threadId, thinking: false, backend: turnBackend.id, agent: turnAgentTag, assistantMessageId },
            });
            break;

          case 'thinking':
            wsMsg = JSON.stringify({
              channel: 'orchestrator',
              event: 'output',
              data: { text: event.text, repoPath, threadId, thinking: true, backend: turnBackend.id, agent: turnAgentTag, assistantMessageId },
            });
            break;

          case 'tool_use':
            wsMsg = JSON.stringify({
              channel: 'orchestrator',
              event: 'tool-use',
              data: { name: event.name, args: event.input, toolUseId: event.id ?? null, repoPath, threadId, backend: turnBackend.id, agent: turnAgentTag, assistantMessageId },
            });
            break;

          case 'tool_result':
            wsMsg = JSON.stringify({
              channel: 'orchestrator',
              event: 'tool-result',
              data: {
                name: event.name,
                args: event.input,
                output: event.output,
                toolUseId: event.id ?? null,
                repoPath,
                threadId,
                backend: turnBackend.id,
                agent: turnAgentTag,
                ...(event.isError ? { isError: true } : {}),
              },
            });
            break;

          case 'plan':
            wsMsg = JSON.stringify({
              channel: 'orchestrator',
              event: 'plan-update',
              data: {
                repoPath,
                threadId,
                turnId: assistantMessageId ?? null,
                explanation: event.explanation,
                steps: event.steps,
                backend: turnBackend.id,
                agent: turnAgentTag,
              },
            });
            break;

          // ── Collide (MoA) — proposer pre-roll. Forwarded to the faint card; NEVER
          //    accumulated into assistantTextAccum so only the aggregator's reply is
          //    the persisted, visible answer.
          case 'collide_phase':
            wsMsg = JSON.stringify({
              channel: 'orchestrator',
              event: 'collide-phase',
              data: { phase: event.phase, proposers: event.proposers ?? [], repoPath, threadId, backend: turnBackend.id, agent: turnAgentTag },
            });
            break;

          case 'collide_proposal':
            wsMsg = JSON.stringify({
              channel: 'orchestrator',
              event: 'collide-proposal',
              data: { proposer: event.proposer, text: event.text, breach: event.breach ?? false, repoPath, threadId, backend: turnBackend.id, agent: turnAgentTag },
            });
            break;

          case 'done':
            if (suppressQuotaError) {
              pendingDone = event;
              break;
            }
            emitDone(event);
            break;

          case 'error':
            if (suppressQuotaError && isRuntimeQuotaLimitError(event)) {
              quotaFallbackError = event.error;
              break;
            }
            sawTerminal = true;
            persistAssistantText(null, turnBackend.id);
            try {
              const failedThread = markMobileOrchestratorThreadFailed({
                tabId: threadId,
                repoPath,
                error: event.error,
                backend: turnBackend.id,
                agent: turnAgentTag,
              });
              if (failedThread) {
                broadcast({
                  channel: 'orchestrator-threads',
                  event: 'upsert',
                  data: { thread: failedThread },
                });
              }
            } catch (markErr) {
              console.warn('[ws-server][orchestrator] failed to mark thread failed', markErr);
            }
            wsMsg = JSON.stringify({
              channel: 'orchestrator',
              event: 'error',
              data: { error: event.error, repoPath, threadId, backend: turnBackend.id, agent: turnAgentTag },
            });
            break;
        }

        if (wsMsg && sessionName) broadcastToOrchestratorSession(sessionName, wsMsg);
      }, turnController!.signal, overrideModel);
      if (pendingDone && !quotaFallbackError) emitDone(pendingDone);
    };

    // Spawn the selected orchestrator and stream structured JSON events to
    // subscribers. Every event is tagged with its actual backend (and `agent`,
    // for openclaw) so fallback handoffs do not cross-contaminate transcripts.
    const resolveQuotaFallback = (currentModel: string | null = model ?? null) => (
      orchestratorModeAllowsBackendFallback(msg.orchestrationMode)
        ? resolveCrossHouseFallback({
            role: crossHouseRole,
            backend: activeBackend.id,
            subscriptionProfile,
            model: currentModel,
          })
        : null
    );
    try {
      await runBackendTurn(activeBackend, activeAgentTag, !!resolveQuotaFallback());
    } catch (err) {
      if (!resolveQuotaFallback() || !isRuntimeQuotaLimitError(err)) throw err;
      quotaFallbackError = err instanceof Error ? err.message : String(err);
    }

    const fallback = quotaFallbackError
      ? resolveCrossHouseFallbackForQuota(quotaFallbackError, {
          role: crossHouseRole,
          backend: activeBackend.id,
          subscriptionProfile,
          model,
        })
      : null;
    if (fallback && sessionName && turnController && !turnController.signal.aborted) {
      const handoffNoticeId = `cross-house-handoff-${threadId ?? 'repo'}-${Date.now()}`;
      const handoffMessage = buildCrossHouseFallbackMessage(fallback);
      const handoffNoticePayload = {
        repoPath,
        threadId,
        kind: fallback.noticeKind,
        noticeId: handoffNoticeId,
        message: handoffMessage,
        registered: [`${fallback.fromModel} -> ${fallback.toModel}`],
      };
      broadcastToOrchestratorSession(sessionName, JSON.stringify({
        channel: 'orchestrator',
        event: 'notice',
        data: {
          ...handoffNoticePayload,
          backend: activeBackend.id,
        },
      }));
      if (fallback.action === 'hold') {
        sawTerminal = true;
        broadcastToOrchestratorSession(sessionName, JSON.stringify({
          channel: 'orchestrator',
          event: 'status',
          data: { status: 'ready', repoPath, threadId, backend: activeBackend.id, agent: activeAgentTag },
        }));
      } else {
        activeBackend = getOrchestratorBackend(fallback.toBackend);
        activeAgentId = '';
        activeAgentTag = undefined;
        abortKey = orchestratorAbortKey(repoPath, activeBackend.id, activeAgentId, threadId);
        turnAbortKeys.add(abortKey);
        sessionName = orchestratorRouteSessionName(
          activeBackend.ensureSession(repoPath, activeAgentTag, threadId).sessionName,
          threadId,
        );
        orchestratorSubscriptions.set(orchestratorSubKey(client.id, activeBackend.id, activeAgentId), {
          clientId: client.id,
          repoPath,
          sessionName,
          threadId,
          backend: activeBackend.id,
          agent: activeAgentId,
        });
        const fallbackRoute = {
          repoPath,
          threadId,
          fromBackend: fallback.fromBackend,
          toBackend: activeBackend.id,
          toSessionName: sessionName,
        };
        activeOrchestratorRoutes.release(activeRouteHandle);
        activeRouteHandle = activeOrchestratorRoutes.register(fallbackRoute);
        promoteOrchestratorFallbackSubscribers(fallbackRoute);
        orchestratorInflightAborts.set(abortKey, turnController);
        broadcastToOrchestratorSession(sessionName, JSON.stringify({
          channel: 'orchestrator',
          event: 'notice',
          data: {
            ...handoffNoticePayload,
            backend: activeBackend.id,
          },
        }));
        broadcastToOrchestratorSession(sessionName, JSON.stringify({
          channel: 'orchestrator',
          event: 'status',
          data: { status: 'busy', repoPath, threadId, backend: activeBackend.id },
        }));
        quotaFallbackError = null;
        try {
          await runBackendTurn(
            activeBackend,
            activeAgentTag,
            true,
            fallback.toModel,
          );
        } catch (err) {
          if (!isRuntimeQuotaLimitError(err)) throw err;
          quotaFallbackError = err instanceof Error ? err.message : String(err);
        }
        if (quotaFallbackError) {
          sawTerminal = true;
          broadcastToOrchestratorSession(sessionName, JSON.stringify({
            channel: 'orchestrator',
            event: 'notice',
            data: {
              repoPath,
              threadId,
              kind: fallback.noticeKind,
              noticeId: `cross-house-handoff-${threadId ?? 'repo'}-${Date.now()}`,
              message: `${fallback.toHouse === 'anthropic' ? 'Anthropic' : 'OpenAI'} subscription also exhausted. Orchestrator work is paused without a metered fallback.`,
              registered: [`${fallback.toModel} exhausted`],
              backend: activeBackend.id,
            },
          }));
          broadcastToOrchestratorSession(sessionName, JSON.stringify({
            channel: 'orchestrator',
            event: 'status',
            data: { status: 'ready', repoPath, threadId, backend: activeBackend.id, agent: activeAgentTag },
          }));
        }
      }
    }

    // The stream resolved without ever emitting 'done'/'error' (hung child that
    // produced nothing, then exited). Synthesize the terminal 'ready' so the
    // client latch releases instead of counting up to the 4-hour reaper.
    // (2026-06-22 latch audit)
    if (!sawTerminal && sessionName) {
      persistAssistantText(null);
      broadcastToOrchestratorSession(sessionName, JSON.stringify({
        channel: 'orchestrator',
        event: 'status',
        data: { status: 'ready', repoPath, threadId, backend: activeBackend.id, agent: activeAgentTag },
      }));
    }

    // #624 — Release the in-flight controller. Keyed compare guards against a
    // newer turn having already replaced this entry.
    for (const key of turnAbortKeys) {
      if (orchestratorInflightAborts.get(key) === turnController) {
        orchestratorInflightAborts.delete(key);
      }
    }
    activeOrchestratorRoutes.release(activeRouteHandle);

    // After the user message completes, drain any queued supervisor escalations.
    void drainOrchestratorAutoQueue();
  } catch (err) {
    const projectError = err instanceof OrchestratorThreadProjectError ? err : null;
    const turnWasUndone = undoneOrchestratorUserMessageIds.has(userMessageId);
    activeOrchestratorRoutes.release(activeRouteHandle);
    if (turnController) {
      for (const key of turnAbortKeys) {
        if (orchestratorInflightAborts.get(key) === turnController) {
          orchestratorInflightAborts.delete(key);
        }
      }
    }
    // Save any partial assistant text accumulated before the failure so
    // mobile listings still show what arrived rather than a blank turn.
    persistAssistantText(null);
    if (!turnWasUndone && !projectError) {
      try {
        const failedThread = markMobileOrchestratorThreadFailed({
          tabId: threadId,
          repoPath,
          error: err instanceof Error ? err.message : 'Failed to send message',
          backend: activeBackend.id,
          agent: activeAgentTag,
        });
        if (failedThread) {
          broadcast({
            channel: 'orchestrator-threads',
            event: 'upsert',
            data: { thread: failedThread },
          });
        }
      } catch (markErr) {
        console.warn('[ws-server][orchestrator] failed to mark thread failed', markErr);
      }
    }
    if (turnWasUndone) {
      if (sessionName) {
        broadcastToOrchestratorSession(sessionName, JSON.stringify({
          channel: 'orchestrator',
          event: 'status',
          data: { status: 'ready', repoPath, threadId, backend: activeBackend.id, agent: activeAgentTag },
        }));
      }
      return;
    }
    // Broadcast the error to EVERY subscriber on this thread, not just the
    // origin client — a phone-started turn that throws must also release the
    // desktop watching the same thread (it was latching forever). Fall back to
    // the origin client only if the session name was never resolved.
    const errorMsg = {
      channel: 'orchestrator' as const,
      event: 'error' as const,
      data: {
        error: err instanceof Error ? err.message : 'Failed to send message',
        ...(projectError?.toPayload() ?? {}),
        repoPath,
        threadId,
        backend: activeBackend.id,
        agent: activeAgentTag,
        ...orchestratorCommandAckCorrelation(correlationId),
      },
    };
    if (sessionName) {
      broadcastToOrchestratorSession(sessionName, JSON.stringify(errorMsg));
    } else {
      send(client, errorMsg);
    }
    // withIdempotency releases a thrown reservation. Only do that when the
    // command failed before the accepted ACK point; once accepted, a backend
    // failure is the terminal outcome for this id and must replay, not rerun.
    if (correlationId && !commandAccepted) {
      throw new OrchestratorSendRejectedBeforeAcceptance(err);
    }
  } finally {
    undoneOrchestratorUserMessageIds.delete(userMessageId);
  }
}

// #624 — User clicked the stop pill. Aborts the in-flight controller for this
// repo; the abort listener inside sendToOrchestrator kills the claude CLI
// subprocess with SIGTERM, which triggers the normal 'done'/close event path
// so subscribers transition back to 'ready'. Clients also optimistically flip
// status to idle the moment they send this message, so the composer unlocks
// without waiting for the server round-trip.
function handleOrchestratorInterrupt(client: ClientState, msg: Record<string, unknown>) {
  const repoPath = resolveOrchestratorMessageRepoPath(msg);
  if (!repoPath) return;
  const threadId = resolveMsgThreadId(msg);
  const requestedBackendId = resolveMsgBackendId(msg);
  const activeRoute = activeOrchestratorRoutes.resolve({ repoPath, threadId, requestedBackend: requestedBackendId });
  const backendId = activeRoute?.toBackend ?? requestedBackendId;
  const agentId = activeRoute ? '' : resolveMsgAgentId(msg, backendId);
  const correlationId = resolveOrchestratorCommandCorrelationId(msg);
  const label = `${backendId}${agentId ? `/${agentId}` : ''}`;
  const controller = orchestratorInflightAborts.get(orchestratorAbortKey(repoPath, backendId, agentId, threadId));
  if (!controller) {
    console.log(`[ws-server] orchestrator-interrupt for ${repoPath} (${label}${threadId ? ` ${threadId}` : ''}) — no in-flight turn`);
    const disposition = orchestratorInterruptAckDisposition({ hasController: false, alreadyAborted: false });
    sendOrchestratorInterruptAck(client, {
      repoPath,
      threadId,
      backend: backendId,
      agent: agentId || undefined,
      correlationId,
      ...disposition,
      note: 'No in-flight turn.',
    });
    return;
  }
  if (controller.signal.aborted) {
    console.log(`[ws-server] orchestrator-interrupt for ${repoPath} (${label}${threadId ? ` ${threadId}` : ''}) — already interrupted`);
    const disposition = orchestratorInterruptAckDisposition({ hasController: true, alreadyAborted: true });
    sendOrchestratorInterruptAck(client, {
      repoPath,
      threadId,
      backend: backendId,
      agent: agentId || undefined,
      correlationId,
      ...disposition,
      note: 'Interrupt was already accepted.',
    });
    return;
  }
  console.log(`[ws-server] orchestrator-interrupt for ${repoPath} (${label}${threadId ? ` ${threadId}` : ''}, client ${client.id})`);
  controller.abort();
  const disposition = orchestratorInterruptAckDisposition({ hasController: true, alreadyAborted: false });
  sendOrchestratorInterruptAck(client, {
    repoPath,
    threadId,
    backend: backendId,
    agent: agentId || undefined,
    correlationId,
    ...disposition,
  });
  // Leave the map entry in place; handleOrchestratorSendMsg removes it when
  // the turn resolves (the abort causes close to fire within 1-2s).
}

function handleOrchestratorUndoSend(client: ClientState, msg: Record<string, unknown>) {
  const repoPath = resolveOrchestratorMessageRepoPath(msg);
  const threadId = resolveMsgThreadId(msg);
  const correlationId = resolveOrchestratorCommandCorrelationId(msg);
  const userMessageId = typeof msg.userMessageId === 'string' ? msg.userMessageId.trim() : '';
  if (!threadId?.startsWith('thoughts-') || !correlationId) return;
  if (userMessageId !== `orch-user-${correlationId}`) return;

  undoneOrchestratorUserMessageIds.add(userMessageId);
  // A completed turn may receive undo just after its send handler released;
  // bound the tombstone even when there is no handler left to clear it.
  setTimeout(() => undoneOrchestratorUserMessageIds.delete(userMessageId), 60_000).unref?.();

  handleOrchestratorInterrupt(client, msg);
  const updatedThread = truncateMobileOrchestratorThreadFromMessage({
    tabId: threadId,
    messageId: userMessageId,
  });
  if (updatedThread) {
    broadcast({
      channel: 'orchestrator-threads',
      event: 'upsert',
      data: { thread: updatedThread },
    });
  }

  send(client, {
    channel: 'orchestrator',
    event: 'undo-ack',
    data: {
      repoPath,
      threadId,
      userMessageId,
      ...orchestratorCommandAckCorrelation(correlationId),
    },
  });
}

async function handleOrchestratorStatus(client: ClientState, msg: Record<string, unknown>) {
  const repoPath = resolveOrchestratorMessageRepoPath(msg);
  if (!repoPath) return;

  // Status for the requested backend (#1075) + openclaw agent. The default
  // Orchestrator tab omits `backend`/`agent` → the global default; the openclaw
  // surface passes both.
  const backend = getOrchestratorBackend(resolveMsgBackendId(msg));
  const agentId = resolveMsgAgentId(msg, backend.id);
  const agentTag = agentId || undefined;
  const threadId = resolveMsgThreadId(msg);
  const session = backend.peekSession(repoPath, agentTag, threadId);
  const status = session?.status ?? 'dead';
  const sessionName = session ? orchestratorRouteSessionName(session.sessionName, threadId) : null;

  send(client, {
    channel: 'orchestrator',
    event: 'status',
    data: {
      status,
      repoPath,
      sessionName,
      threadId,
      backend: backend.id,
      agent: agentTag,
    },
  });

  // Status-probe recovery: an active turn's latest plan snapshot rides along
  // (marked `snapshot: true`) so a client that polled its way back mid-turn
  // regains the plan card. The cache only exists while a turn is live — it is
  // cleared at the broadcast chokepoint on ready/dead/error — and the same
  // stale-busy heal window the subscribe path uses gates a wedged session.
  if (status === 'busy' && sessionName) {
    const lastActivityAt = lastOrchestratorActivityAt.get(sessionName) ?? 0;
    if (Date.now() - lastActivityAt <= ORCH_SNAPSHOT_STALE_MS) {
      const planData = latestOrchestratorPlanBySession.get(sessionName);
      if (planData) {
        send(client, { channel: 'orchestrator', event: 'plan-update', data: { ...planData, snapshot: true } });
      }
    }
  }
}

async function syncClientInbox(client: ClientState) {
  // Delta-capable clients receive revisioned inbox events from the realtime
  // log. Suppress the legacy full snapshot safety poll after negotiation; the
  // initial connection/bootstrap checkpoint still seeds canonical state.
  if (client.realtimeCapabilities.has(MOBILE_INBOX_DELTA_CAPABILITY)) return;
  const data = await fetchSync({ inbox: { etag: client.inboxEtag ?? undefined } });
  if (!data) return;

  if (data.inboxEtag) client.inboxEtag = data.inboxEtag as string;

  if (data.inbox) {
    send(client, { channel: 'inbox', event: 'update', data: data.inbox });
  }
}

async function syncClientHistory(client: ClientState) {
  if (!client.sessionKey) return;

  const body: Record<string, unknown> = {
    history: {
      sessionKey: client.sessionKey,
      sinceId: client.lastHistoryId ?? undefined,
      limit: 18,
    },
  };

  const data = await fetchSync(body);
  if (!data?.history) return;

  const history = data.history as { entries: Array<{ id: string }>; sessionKey: string };
  if (history.entries.length > 0) {
    // Track last seen ID for delta fetching
    client.lastHistoryId = history.entries[history.entries.length - 1].id;
    send(client, { channel: 'history', event: 'update', data: history });
  }
}

// ── Chat delta forwarding ──

function onChatDelta(delta: ChatDelta) {
  const text = extractText(delta);
  const sessionFilter = (c: ClientState) => c.sessionKey === delta.sessionKey;

  if (delta.state === 'delta') {
    broadcast({ channel: 'chat', event: 'delta', data: { text, runId: delta.runId, seq: delta.seq } }, sessionFilter);
  } else if (delta.state === 'done') {
    broadcast({ channel: 'chat', event: 'done', data: { text, runId: delta.runId, seq: delta.seq } }, sessionFilter);
    setTimeout(() => pushHistoryForSession(delta.sessionKey), 500);
    scheduleEventDrivenInboxPush();
    scheduleRealtimeSessionHistoryRefresh(delta.sessionKey, true, undefined, { urgent: true });
    scheduleRealtimeRuntimeRefresh({ reason: 'chat.done', fresh: true });
    scheduleRealtimeMobileInboxRefresh(250, true);
  } else if (delta.state === 'error' || delta.state === 'aborted') {
    broadcast({ channel: 'chat', event: 'error', data: { state: delta.state, error: delta.error, runId: delta.runId } }, sessionFilter);
    scheduleEventDrivenInboxPush();
    scheduleRealtimeSessionHistoryRefresh(delta.sessionKey, true, undefined, { urgent: true });
    scheduleRealtimeRuntimeRefresh({ reason: `chat.${delta.state}`, fresh: true });
    scheduleRealtimeMobileInboxRefresh(250, true);
  }
}

chatListeners.add(onChatDelta);

// ── Event-driven push with safety-net polling ──

let inboxPushTimer: ReturnType<typeof setTimeout> | null = null;
const INBOX_PUSH_DEBOUNCE_MS = 300;
const SAFETY_NET_INBOX_MS = 10_000; // 10s safety net (was 3s active poll)
const SAFETY_NET_HISTORY_MS = 8_000; // 8s safety net (was 2s active poll)

function scheduleEventDrivenInboxPush() {
  if (inboxPushTimer) clearTimeout(inboxPushTimer);
  inboxPushTimer = setTimeout(() => {
    inboxPushTimer = null;
    const activeClients = [...clients.values()].filter((c) => c.ws.readyState === WebSocket.OPEN);
    if (activeClients.length === 0) return;
    void Promise.allSettled(activeClients.map((c) => syncClientInbox(c)));
  }, INBOX_PUSH_DEBOUNCE_MS);
}

function pushHistoryForSession(sessionKey: string) {
  const matchingClients = [...clients.values()].filter(
    (c) => c.ws.readyState === WebSocket.OPEN && c.sessionKey === sessionKey,
  );
  if (matchingClients.length === 0) return;
  void Promise.allSettled(matchingClients.map((c) => syncClientHistory(c)));
}

const CONFLICT_SCAN_MS = 5_000; // 5s conflict scan interval

// ── Conflict scan: event-driven, with a slow safety net ──
//
// The scan used to run the FULL worktree probe every 5 seconds regardless of
// whether anything had changed, then throw the result away when the hash matched
// — which, on an idle app, is every single time. On the operator's Intel box
// that was ~519ms of git subprocesses per tick (~10% of a core, forever) to
// re-derive an answer nobody asked for.
//
// The expensive probe now runs only when something could actually have changed:
// a git ref/index write, a worktree HEAD/index write, or a file written inside
// any worktree. That last one matters — agents edit files long before they stage
// them, so watching .git alone would miss work in progress.
//
// Event-driven detection is also STRICTLY FASTER than the old poll: a change is
// noticed within the debounce rather than up to 5s later.
//
// `conflictWatchersActive` is the safety valve. If the watchers can't be
// established (EMFILE, a platform without recursive fs.watch), we fall back to
// the old unconditional 5s scan — never worse than before. And even with the
// watchers live, a slow full rescan runs regardless every
// CONFLICT_SAFETY_NET_MS, so a missed event can't strand the report forever.
const CONFLICT_SAFETY_NET_MS = 60_000;
let conflictsDirty = true; // always scan once on boot
let conflictWatchersActive = false;
let lastFullConflictScan = 0;

function markConflictsDirty() {
  conflictsDirty = true;
}

function startPollingLoops() {
  // Safety-net inbox poll — reduced frequency since event-driven push handles most updates
  setInterval(() => {
    const activeClients = [...clients.values()].filter((c) => c.ws.readyState === WebSocket.OPEN);
    if (activeClients.length === 0) return;
    void Promise.allSettled(activeClients.map((c) => syncClientInbox(c)));
  }, SAFETY_NET_INBOX_MS);

  // ActivityKit remote updates must keep flowing after the phone suspends and
  // the websocket disappears. This low-frequency loop reuses the mobile inbox
  // fingerprint/signature path and only sends APNs when the Live Activity
  // payload changed.
  setInterval(() => {
    void publishMobileInboxRealtimeSnapshot(false);
  }, 30_000);

  // Safety-net history poll — reduced frequency since chat.done triggers immediate push
  setInterval(() => {
    const activeClients = [...clients.values()].filter(
      (c) => c.ws.readyState === WebSocket.OPEN && c.sessionKey,
    );
    if (activeClients.length === 0) return;
    void Promise.allSettled(activeClients.map((c) => syncClientHistory(c)));
  }, SAFETY_NET_HISTORY_MS);

  // Built-in o8/Claude orchestrator thread sync. The Next API process owns
  // chat-history writes; this WS bridge watches the durable records and pushes
  // thread create/update/reveal events to desktop + mobile clients.
  let orchestratorThreadSyncInFlight = false;
  setInterval(() => {
    // Overlap guard: the sync is now async (fs.promises); skip a tick rather
    // than let a slow scan stack up on the event loop.
    if (orchestratorThreadSyncInFlight) return;
    orchestratorThreadSyncInFlight = true;
    void pushOrchestratorThreadChanges().finally(() => {
      orchestratorThreadSyncInFlight = false;
    });
  }, 1_000);

  // Conflict scan — poll every 5s, push updates to all clients when conflicts change
  // TODO: Track repo per client session for multi-repo support (currently uses process.cwd())
  let lastConflictHash = '';
  setInterval(async () => {
    const activeClients = [...clients.values()].filter((c) => c.ws.readyState === WebSocket.OPEN);
    if (activeClients.length === 0) return;

    // Nothing has changed since the last scan — skip the expensive probe
    // entirely. The gate fails toward scanning in every ambiguous case; see
    // lib/ws-server/conflict-gate.ts.
    if (!shouldRunConflictScan({
      watchersActive: conflictWatchersActive,
      dirty: conflictsDirty,
      msSinceFullScan: Date.now() - lastFullConflictScan,
      safetyNetMs: CONFLICT_SAFETY_NET_MS,
    })) {
      return;
    }
    // Clear BEFORE the probe, not after: a write that lands while the probe is
    // in flight must re-arm the next tick rather than be swallowed by it.
    conflictsDirty = false;
    lastFullConflictScan = Date.now();

    try {
      const res = await fetchWithRetry(buildNextUrl('/api/worktrees/conflicts', new URLSearchParams({
        repo: process.cwd(),
      })), {
        headers: {
          'Cache-Control': 'no-cache',
          'Authorization': `Bearer ${WS_TOKEN}`,
        },
        signal: AbortSignal.timeout(3000),
      });

      if (!res.ok) return;
      const report = await res.json();

      // Only push if conflicts changed (compare hash of file list)
      const hash = JSON.stringify(report.files?.map((f: { file: string; severity: string }) => `${f.file}:${f.severity}`).sort());
      if (hash === lastConflictHash) return;
      const previousHash = lastConflictHash;
      lastConflictHash = hash;

      // Push to all clients (pre-stringify once)
      broadcast({ channel: 'conflicts', event: 'update', data: report });

      // Mobile push — only when we transition from "no conflicts" to "has
      // conflicts" so users don't get a notification per file change.
      const fileCount = Array.isArray(report.files) ? report.files.length : 0;
      if (fileCount > 0 && (previousHash === '' || previousHash === '[]')) {
        void import('@/lib/push/notify')
          .then(({ notifyMergeConflict }) => {
            notifyMergeConflict({ repo: process.cwd().split('/').pop() ?? 'repo', fileCount });
          })
          .catch((error) => {
            console.warn('[ws-server] push notify (conflicts) failed', error);
          });
      }
    } catch {
      // Non-critical — conflict scanning is best-effort
    }
  }, CONFLICT_SCAN_MS);
}

// ── Terminal handlers ──

/** Find an existing detached dashboard PTY session to reuse, or return null. */
function findExistingDashSession(): string | null {
  for (const [sessionName, attachment] of terminalAttachments) {
    if (attachment.kind === 'dash-shell' && attachment.clientIds.size === 0) {
      return sessionName;
    }
  }
  return null;
}

// Helper — all terminal events must wrap payload in `data` to match hook parser
function sendTerminal(client: ClientState, event: string, payload: Record<string, unknown>) {
  send(client, { channel: 'terminal', event, data: payload });
}

function materializePendingDashSession(
  client: ClientState,
  sessionName: string,
  cols?: number,
  rows?: number,
) {
  const pending = pendingDashSessions.get(sessionName);
  if (!pending) {
    return undefined;
  }

  const nextCols = typeof cols === 'number' ? cols : pending.cols;
  const nextRows = typeof rows === 'number' ? rows : pending.rows;
  // #6 persistent terminals — when enabled + tmux is available, back the dash
  // shell with a tmux session (survives a crash) and attach a PTY view to it;
  // otherwise the legacy plain-shell PTY. createDashTmuxSessionSync returns false
  // (gate off / no tmux / failure) → graceful fallback.
  const ptyProcess = createDashTmuxSessionSync(sessionName, nextCols, nextRows, pending.cwd)
    ? spawnTmuxAttachPty(sessionName, nextCols, nextRows)
    : spawnDashShellPty(sessionName, nextCols, nextRows, pending.cwd);
  const now = Date.now();
  const attachment: TerminalAttachment = {
    id: randomUUID(),
    sessionName,
    kind: 'dash-shell',
    ptyProcess,
    clientIds: new Set([client.id]),
    cols: nextCols,
    rows: nextRows,
    batchBuffer: '',
    batchTimer: null,
    lastOutputAt: now,
    createdAt: now,
    orphanTimer: null,
    scrollbackChunks: [],
    scrollbackBytes: 0,
  };
  terminalAttachments.set(sessionName, attachment);
  client.terminalSessions.add(sessionName);
  registerTerminalAttachment(attachment);
  pendingDashSessions.delete(sessionName);
  console.log(`[ws-server] Materialized dashboard PTY session: ${sessionName}`);
  return attachment;
}

function handleTerminalCreate(client: ClientState, msg: Record<string, unknown>) {
  if (!terminalHost) {
    sendTerminal(client, 'error', { sessionName: '', error: 'Terminal not available (node-pty not installed)' });
    return;
  }

  const cols = typeof msg.cols === 'number' ? msg.cols : 120;
  const rows = typeof msg.rows === 'number' ? msg.rows : 30;
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : undefined;
  // Optional working directory (canvas terminals spawn per-repo). Validated
  // here so a bad path falls back to the default HOME spawn instead of erroring.
  const requestedCwd = typeof msg.cwd === 'string' ? msg.cwd.trim() : '';
  const cwd = requestedCwd && existsSync(requestedCwd) ? requestedCwd : undefined;

  // Only opportunistically reuse orphaned dashboard shells for non-targeted creates.
  // Explicit request IDs should always receive a fresh tmux session so ownership is deterministic.
  const existing = findExistingDashSession();
  if (!requestId && existing) {
    console.log(`[ws-server] Reusing existing dashboard PTY session: ${existing}`);
    sendTerminal(client, 'created', { sessionName: existing, requestId });
    handleTerminalAttach(client, { sessionName: existing, cols, rows });
    return;
  }

  const shortId = randomUUID().slice(0, 8);
  const sessionName = `cortex-dash-${shortId}`;
  pendingDashSessions.set(sessionName, { cols, rows, cwd });
  console.log(`[ws-server] Reserved dashboard PTY session: ${sessionName}${cwd ? ` (cwd ${cwd})` : ''}`);
  sendTerminal(client, 'created', { sessionName, requestId });
}

function handleTerminalAttach(client: ClientState, msg: Record<string, unknown>) {
  const sessionName = msg.sessionName as string;
  if (!sessionName || typeof sessionName !== 'string') {
    sendTerminal(client, 'error', { sessionName: '', error: 'sessionName required' });
    return;
  }

  if (!terminalHost) {
    sendTerminal(client, 'error', { sessionName, error: 'Terminal not available (node-pty not installed)' });
    return;
  }

  const cols = typeof msg.cols === 'number' ? msg.cols : 120;
  const rows = typeof msg.rows === 'number' ? msg.rows : 30;

  // Check if we already have a PTY for this tmux session
  let attachment = terminalAttachments.get(sessionName);

  if (attachment) {
    // Add this client to existing attachment
    if (attachment.orphanTimer) {
      clearTimeout(attachment.orphanTimer);
      attachment.orphanTimer = null;
    }
    attachment.clientIds.add(client.id);
    client.terminalSessions.add(sessionName);
    sendTerminal(client, 'attached', { sessionName });
    if (attachment.kind === 'dash-shell') {
      sendTerminalScrollback(client, attachment);
    }
    console.log(`[ws-server] Client ${client.id} attached to existing terminal ${sessionName}`);
    return;
  }

  try {
    attachment = materializePendingDashSession(client, sessionName, cols, rows);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[ws-server] Failed to materialize dashboard terminal ${sessionName}:`, error);
    sendTerminal(client, 'error', { sessionName, error: `Failed to create terminal: ${error}` });
    return;
  }

  if (attachment) {
    sendTerminal(client, 'attached', { sessionName });
    sendTerminalScrollback(client, attachment);
    console.log(`[ws-server] Client ${client.id} attached to lazily created terminal ${sessionName}`);
    return;
  }

  // #6 persistent terminals — re-attach to a dash session that survived a
  // ws-server restart / app crash. After a restart the in-memory map is empty,
  // so the create-from-pending path above misses; but the detached tmux session
  // is still alive. Spawn a fresh attach-client PTY over it and replay the pane
  // history (the scrollback ring is empty on a cold re-attach).
  if (
    isDashTerminalSession(sessionName)
    && dashPersistentTerminalsEnabled()
    && tmuxSessionExists(sessionName)
  ) {
    try {
      const ptyProcess = spawnTmuxAttachPty(sessionName, cols, rows);
      const now = Date.now();
      attachment = {
        id: randomUUID(),
        sessionName,
        kind: 'dash-shell',
        ptyProcess,
        clientIds: new Set([client.id]),
        cols,
        rows,
        batchBuffer: '',
        batchTimer: null,
        lastOutputAt: now,
        createdAt: now,
        orphanTimer: null,
        scrollbackChunks: [],
        scrollbackBytes: 0,
      };
      terminalAttachments.set(sessionName, attachment);
      client.terminalSessions.add(sessionName);
      registerTerminalAttachment(attachment);
      // Seed the ring with tmux's pane history, minus the trailing visible rows
      // (the `tmux attach` repaints those itself — trimming avoids a duplicated
      // current screen at the seam).
      const history = captureTmuxPane(sessionName);
      if (history) {
        const lines = history.replace(/\n+$/, '').split('\n');
        const keep = lines.length > rows ? lines.slice(0, lines.length - rows).join('\n') : '';
        if (keep) appendScrollback(attachment, `${keep}\n`);
      }
      sendTerminal(client, 'attached', { sessionName });
      sendTerminalScrollback(client, attachment);
      console.log(`[ws-server] [persistent-terminals] re-attached surviving dash session ${sessionName}`);
      return;
    } catch (err) {
      console.error(`[ws-server] [persistent-terminals] re-attach failed for ${sessionName}:`, err instanceof Error ? err.message : String(err));
      // fall through to the standard "no longer exists" reply
    }
  }

  if (isDashTerminalSession(sessionName)) {
    sendTerminal(client, 'error', { sessionName, error: 'Dashboard terminal session no longer exists. Create a new shell.' });
    return;
  }

  // Spawn a new PTY that attaches to the tmux session
  try {
    const ptyProcess = spawnTmuxAttachPty(sessionName, cols, rows);

    const now = Date.now();
    attachment = {
      id: randomUUID(),
      sessionName,
      kind: 'tmux-attach',
      ptyProcess,
      clientIds: new Set([client.id]),
      cols,
      rows,
      batchBuffer: '',
      batchTimer: null,
      lastOutputAt: now,
      createdAt: now,
      orphanTimer: null,
      scrollbackChunks: [],
      scrollbackBytes: 0,
    };

    terminalAttachments.set(sessionName, attachment);
    client.terminalSessions.add(sessionName);
    registerTerminalAttachment(attachment);

    sendTerminal(client, 'attached', { sessionName });
    console.log(`[ws-server] Client ${client.id} attached to new terminal ${sessionName}`);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[ws-server] Failed to attach terminal ${sessionName}:`, error);
    sendTerminal(client, 'error', { sessionName, error });
  }
}

function handleTerminalInput(client: ClientState, msg: Record<string, unknown>) {
  const sessionName = msg.sessionName as string;
  const data = msg.data as string;
  if (!sessionName || typeof data !== 'string') return;

  let attachment = terminalAttachments.get(sessionName);
  if (!attachment && isDashTerminalSession(sessionName) && pendingDashSessions.has(sessionName)) {
    try {
      attachment = materializePendingDashSession(client, sessionName);
      if (attachment) {
        sendTerminal(client, 'attached', { sessionName });
      }
    } catch (error) {
      sendTerminal(client, 'error', {
        sessionName,
        error: error instanceof Error ? error.message : 'Failed to create terminal',
      });
      return;
    }
  }
  if (!attachment || !attachment.clientIds.has(client.id)) return;

  try {
    attachment.ptyProcess.write(data);
  } catch { /* PTY may have exited */ }
}

function handleTerminalResize(client: ClientState, msg: Record<string, unknown>) {
  const sessionName = msg.sessionName as string;
  const cols = msg.cols as number;
  const rows = msg.rows as number;
  if (!sessionName || typeof cols !== 'number' || typeof rows !== 'number') return;

  const attachment = terminalAttachments.get(sessionName);
  if (!attachment) {
    if (isDashTerminalSession(sessionName) && pendingDashSessions.has(sessionName)) {
      const pending = pendingDashSessions.get(sessionName);
      pendingDashSessions.set(sessionName, { cols, rows, cwd: pending?.cwd });
    }
    return;
  }

  try {
    attachment.ptyProcess.resize(cols, rows);
    attachment.cols = cols;
    attachment.rows = rows;
  } catch { /* resize may fail if PTY exited */ }
}

const TERMINAL_IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.heic',
]);
const TERMINAL_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

async function handleTerminalImage(_client: ClientState, msg: Record<string, unknown>) {
  const sessionName = typeof msg.sessionName === 'string' ? msg.sessionName : '';
  const filePath = typeof msg.filePath === 'string' ? msg.filePath : '';
  if (!sessionName || !filePath) return;

  try {
    const resolved = resolve(filePath.replace(/^~/, process.env.HOME ?? '/tmp'));
    // Token-authenticated channel, but it must not double as a generic
    // file-read primitive (a ws-token holder could otherwise lift the signing
    // key or any dotfile). Images only, regular files only, capped size.
    const ext = extname(resolved).toLowerCase();
    if (!TERMINAL_IMAGE_EXTENSIONS.has(ext)) {
      console.log(`[ws-server] terminal-image: refused non-image path ${resolved}`);
      return;
    }
    const fileStat = await stat(resolved);
    if (!fileStat.isFile() || fileStat.size > TERMINAL_IMAGE_MAX_BYTES) {
      console.log(`[ws-server] terminal-image: refused ${resolved} (not a regular file or too large)`);
      return;
    }
    const data = await readFile(resolved);
    const b64 = data.toString('base64');
    const filename = basename(resolved);
    // Send raw components — client builds the IIP escape sequence
    const attachment = terminalAttachments.get(sessionName);
    if (!attachment) {
      console.log(`[ws-server] terminal-image: no attachment for ${sessionName}`);
      return;
    }

    const imageMsg = JSON.stringify({
      channel: 'terminal',
      event: 'image',
      data: {
        sessionName,
        filename,
        imageB64: b64,
      },
    });

    for (const cid of attachment.clientIds) {
      const c = clients.get(cid);
      if (c) sendRaw(c, imageMsg);
    }
    console.log(`[ws-server] Sent image to ${attachment.clientIds.size} client(s) on ${sessionName}`);
  } catch (err) {
    console.log(`[ws-server] terminal-image error: ${err instanceof Error ? err.message : 'unknown'}`);
  }
}

function handleTerminalDetach(client: ClientState, msg: Record<string, unknown>) {
  const sessionName = msg.sessionName as string;
  if (!sessionName) return;
  removeClientFromTerminal(client.id, sessionName);
  sendTerminal(client, 'detached', { sessionName });
}

function removeClientFromTerminal(clientId: string, sessionName: string) {
  const attachment = terminalAttachments.get(sessionName);
  if (!attachment) return;

  attachment.clientIds.delete(clientId);
  const c = clients.get(clientId);
  if (c) c.terminalSessions.delete(sessionName);

  // If no more clients, destroy the PTY handle and clean up the tmux session
  if (attachment.clientIds.size === 0) {
    if (attachment.kind === 'dash-shell') {
      // #6 persistent terminals — when persistence is on, a dash PTY is a
      // `tmux attach` client over a detached session, so detaching costs us
      // nothing to keep. Hold BOTH the session and the warm PTY view so
      // reconnect is instant and the scrollback ring survives; the periodic GC
      // sweep (reapOrphanDashSessions) reaps sessions whose tab is gone. The
      // legacy off-path keeps the 30-min reap of the in-memory shell PTY.
      if (dashPersistentTerminalsEnabled()) {
        if (attachment.orphanTimer) {
          clearTimeout(attachment.orphanTimer);
          attachment.orphanTimer = null;
        }
        console.log(`[ws-server] [persistent-terminals] ${sessionName} detached — keeping tmux session + view warm`);
        return;
      }
      if (attachment.orphanTimer) clearTimeout(attachment.orphanTimer);
      attachment.orphanTimer = setTimeout(() => {
        const latest = terminalAttachments.get(sessionName);
        if (!latest || latest.clientIds.size > 0) return;
        console.log(`[ws-server] Reaping idle dashboard PTY session: ${sessionName}`);
        if (latest.batchTimer) clearTimeout(latest.batchTimer);
        try { latest.ptyProcess.kill(); } catch { /* already gone */ }
        terminalAttachments.delete(sessionName);
      }, DASH_SESSION_ORPHAN_TTL_MS);
      console.log(`[ws-server] Dashboard terminal ${sessionName} detached — keeping PTY alive for reattach`);
      return;
    }

    console.log(`[ws-server] No clients left for terminal ${sessionName} — destroying PTY`);
    if (attachment.batchTimer) clearTimeout(attachment.batchTimer);
    try { attachment.ptyProcess.kill(); } catch { /* already gone */ }
    terminalAttachments.delete(sessionName);
  }
}

// ── Agent Lifecycle ──

type LifecycleState = 'active' | 'completed' | 'failed' | 'killed' | 'stalled';

// Track lifecycle state per session name
const agentLifecycleState = new Map<string, {
  state: LifecycleState;
  exitCode?: number;
  killedBy?: string;
  ts: number;
}>();

// ── Stall Detection ──
// Only monitor launched agent terminals (cortex-codex-*, cortex-claude-*)
// NOT dashboard terminals (cortex-dash-*) or background helper sessions
const STALL_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes with no output
const STALL_CHECK_INTERVAL_MS = 30 * 1000; // check every 30s
const STALL_GRACE_MS = 60 * 1000; // ignore first 60s after creation (agent startup)

function isMonitoredAgent(sessionName: string): boolean {
  // Only monitor IDE-launched agent terminals
  // cortex-codex-* and cortex-claude-* are launched agents
  // cortex-dash-* are user dashboard terminals — not monitored
  // Background helper sessions are not monitored
  return sessionName.startsWith('cortex-codex-') || sessionName.startsWith('cortex-claude-');
}

function checkForStalledAgents() {
  const now = Date.now();
  for (const [sessionName, att] of terminalAttachments) {
    if (!isMonitoredAgent(sessionName)) continue;

    // Skip if within grace period (agent startup takes time)
    if (now - att.createdAt < STALL_GRACE_MS) continue;

    // Skip if already in a terminal lifecycle state
    const existing = agentLifecycleState.get(sessionName);
    if (existing && (existing.state === 'completed' || existing.state === 'failed' || existing.state === 'killed')) continue;

    const silentMs = now - att.lastOutputAt;
    if (silentMs >= STALL_THRESHOLD_MS) {
      // Only broadcast if not already stalled (avoid spam)
      if (!existing || existing.state !== 'stalled') {
        console.log(`[ws-server] Stall detected: ${sessionName} — no output for ${Math.round(silentMs / 60000)}m`);
        broadcastLifecycle(sessionName, 'stalled');
      }
    } else if (existing?.state === 'stalled') {
      // Agent resumed producing output — clear stall
      console.log(`[ws-server] Stall cleared: ${sessionName} — output resumed`);
      broadcastLifecycle(sessionName, 'active');
    }
  }
}

// Start stall detection interval (cleaned up on shutdown)
const stallCheckTimer = setInterval(checkForStalledAgents, STALL_CHECK_INTERVAL_MS);

function broadcastLifecycle(sessionName: string, state: LifecycleState, exitCode?: number) {
  const entry = { state, exitCode, ts: Date.now() };
  agentLifecycleState.set(sessionName, entry);

  const msg = JSON.stringify({
    channel: 'agent-lifecycle',
    event: state,
    data: { sessionName, state, exitCode, ts: entry.ts },
  });

  // Broadcast to ALL connected clients (not just terminal subscribers)
  for (const [, c] of clients) {
    sendRaw(c, msg);
  }
  scheduleRealtimeRuntimeRefresh({ reason: `terminal.${state}`, fresh: true });
  scheduleRealtimeMobileInboxRefresh(250, true);
  console.log(`[ws-server] Agent lifecycle: ${sessionName} → ${state}${exitCode !== undefined ? ` (exit ${exitCode})` : ''}`);

  // Fire mobile push for terminal lifecycle states (best-effort).
  if (state === 'completed' || state === 'failed' || state === 'killed' || state === 'stalled') {
    void import('@/lib/push/notify')
      .then(({ notifyAgentFinished }) => {
        notifyAgentFinished({ sessionName, state, exitCode });
      })
      .catch((error) => {
        console.warn('[ws-server] push notify (agent-lifecycle) failed', error);
      });
  }
}

function handleAgentKill(_client: ClientState, msg: Record<string, unknown>) {
  const sessionName = msg.sessionName as string;
  const signal = (msg.signal as string) ?? 'SIGTERM';
  if (!sessionName) return;

  terminateTerminalSession(sessionName, signal);
}

function terminateTerminalSession(sessionName: string, signal: string = 'SIGTERM') {
  if (!sessionName) return;

  console.log(`[ws-server] Kill request for ${sessionName} (signal: ${signal})`);

  // 1. Try killing via PTY attachment (Codex / Claude Code terminals)
  const attachment = terminalAttachments.get(sessionName);
  if (attachment) {
    try {
      if (signal === 'SIGINT') {
        // Send Ctrl+C to the PTY (interrupt, not kill)
        attachment.ptyProcess.write('\x03');
        console.log(`[ws-server] Sent Ctrl+C to ${sessionName}`);
        return;
      }

      attachment.ptyProcess.kill();
      console.log(`[ws-server] Killed PTY for ${sessionName}`);
    } catch (err) {
      console.error(`[ws-server] Failed to kill PTY for ${sessionName}:`, err);
    }
    // Lifecycle broadcast happens via onExit handler
    return;
  }

  // 2. Try killing tmux session directly (if PTY already detached but tmux lives)
  try {
    const tmuxBin = resolveTmuxBinary();
    execFileSync(tmuxBin, ['has-session', '-t', sessionName], {
      timeout: 2000,
      stdio: 'ignore',
      env: sanitizePtyEnv() as NodeJS.ProcessEnv,
    });
    execFileSync(tmuxBin, ['kill-session', '-t', sessionName], {
      timeout: 3000,
      stdio: 'ignore',
      env: sanitizePtyEnv() as NodeJS.ProcessEnv,
    });
    console.log(`[ws-server] Killed tmux session: ${sessionName}`);
    broadcastLifecycle(sessionName, 'killed');
    return;
  } catch { /* no tmux session */ }

  // 3. No PTY or tmux session remains — broadcast the kill state so the UI can reconcile.
  if (sessionName.startsWith('cortex-')) {
    console.log(`[ws-server] No live PTY found for ${sessionName} — skipping stale kill broadcast`);
    return;
  }
  console.log(`[ws-server] No PTY/tmux found for ${sessionName} — broadcasting killed state`);
  broadcastLifecycle(sessionName, 'killed');
}

/** Constant-time equality for the ws-token (avoids a timing side-channel). */
function wsTokenMatches(presented: string): boolean {
  if (!presented || !WS_TOKEN) return false;
  const a = Buffer.from(presented, 'utf-8');
  const b = Buffer.from(WS_TOKEN, 'utf-8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isAuthorizedInternalRequest(req: import('http').IncomingMessage) {
  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return wsTokenMatches(token);
}

// ── Server startup ──

const httpServer = createServer((req, res) => {
  // CORS headers — allow localhost, Tauri, and private/Tailscale IPs (mobile remote access)
  const { apiPort } = resolvePortInfo();
  const allowedOrigins = new Set([
    `http://localhost:${apiPort}`,
    `http://127.0.0.1:${apiPort}`,
    'tauri://localhost',
  ]);
  const origin = req.headers.origin ?? '';
  const isPrivateOrigin = /^https?:\/\/(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(origin);
  if (allowedOrigins.has(origin) || isPrivateOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/terminal-spawn' && req.method === 'POST') {
    if (!isAuthorizedInternalRequest(req)) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      let payload: InternalTerminalSpawnPayload = {};
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as InternalTerminalSpawnPayload;
      } catch {
        res.writeHead(400);
        res.end('invalid json');
        return;
      }

      const sessionName = payload?.sessionName?.trim();
      const shellCommand = payload?.shellCommand?.trim();
      const cwd = payload?.cwd?.trim();
      const cols = typeof payload?.cols === 'number' ? payload.cols : 120;
      const rows = typeof payload?.rows === 'number' ? payload.rows : 30;
      if (!sessionName || !shellCommand || !cwd) {
        res.writeHead(400);
        res.end('sessionName, shellCommand, and cwd are required');
        return;
      }
      if (!/^cortex-[a-z0-9_-]+$/i.test(sessionName)) {
        res.writeHead(400);
        res.end('invalid session name');
        return;
      }
      if (!terminalHost) {
        res.writeHead(503);
        res.end('node-pty unavailable');
        return;
      }
      if (terminalAttachments.has(sessionName)) {
        const existing = terminalAttachments.get(sessionName);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sessionName, pid: existing?.ptyProcess?.pid ?? null }));
        return;
      }

      try {
        const ptyProcess = spawnManagedCommandPty(sessionName, shellCommand, cwd, cols, rows, payload?.env);
        const now = Date.now();
        const attachment: TerminalAttachment = {
          id: randomUUID(),
          sessionName,
          kind: 'managed-process',
          ptyProcess,
          clientIds: new Set(),
          cols,
          rows,
          batchBuffer: '',
          batchTimer: null,
          lastOutputAt: now,
          createdAt: now,
          orphanTimer: null,
          scrollbackChunks: [],
          scrollbackBytes: 0,
          cwd,
          commandHint: shellCommand,
        };
        terminalAttachments.set(sessionName, attachment);
        registerTerminalAttachment(attachment);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sessionName, pid: ptyProcess.pid ?? null }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to spawn terminal session' }));
      }
    });
    return;
  }

  if (req.url === '/terminal-sessions' && req.method === 'GET') {
    if (!isAuthorizedInternalRequest(req)) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }

    const inMemory = [...terminalAttachments.values()]
      .filter((attachment) => attachment.kind === 'dash-shell')
      .map((attachment) => attachment.sessionName);
    // #6 persistent terminals — after a ws-server restart the in-memory map is
    // empty, but surviving dash sessions are still alive in tmux. Union them so
    // the client-side restore (checkAliveSessions) re-attaches instead of
    // respawning a fresh shell. Gated — off-path keeps the in-memory-only list.
    const sessions = dashPersistentTerminalsEnabled()
      ? [...new Set([...inMemory, ...listDashTmuxSessionsWithAge().map((s) => s.name)])]
      : inMemory;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions }));
    return;
  }

  // Native Symon tools use this o8-internal-only inventory rather than
  // automating Terminal.app/iTerm. Keep `/terminal-sessions` unchanged for
  // existing dashboard restore clients.
  if (req.url === '/terminal-voice-sessions' && req.method === 'GET') {
    if (!isAuthorizedInternalRequest(req)) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }
    const sessions = [...terminalAttachments.values()].map((attachment) => ({
      name: attachment.sessionName,
      kind: attachment.kind,
      clientCount: attachment.clientIds.size,
      cwd: attachment.cwd ?? null,
      commandHint: attachment.commandHint ?? null,
      createdAt: new Date(attachment.createdAt).toISOString(),
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions }));
    return;
  }

  if (req.url === '/terminal-voice-input' && req.method === 'POST') {
    if (!isAuthorizedInternalRequest(req)) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      let payload: { sessionName?: string; text?: string; raw?: boolean } | null = null;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { sessionName?: string; text?: string; raw?: boolean };
      } catch {
        res.writeHead(400);
        res.end('invalid json');
        return;
      }
      const sessionName = payload?.sessionName?.trim();
      const text = payload?.text;
      if (!sessionName || typeof text !== 'string' || !text) {
        res.writeHead(400);
        res.end('sessionName and text required');
        return;
      }
      const attachment = terminalAttachments.get(sessionName);
      if (!attachment) {
        res.writeHead(404);
        res.end('session not found');
        return;
      }
      try {
        attachment.ptyProcess.write(payload.raw ? text : `${text}\r`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to write to terminal' }));
      }
    });
    return;
  }

  // Rust's repo-scoped `o8_delegate` tool calls this host instead of driving a
  // canvas. Correlation and repo authority were injected by the Symon relay;
  // the endpoint rechecks both before queuing the orchestrator turn.
  if (req.url === '/symon-orchestrator-turn' && req.method === 'POST') {
    if (!isAuthorizedInternalRequest(req)) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      void (async () => {
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>;
        } catch {
          res.writeHead(400);
          res.end('invalid json');
          return;
        }
        const repoId = typeof payload.repoId === 'string' ? payload.repoId.trim() : '';
        const repoPath = typeof payload.repoPath === 'string' ? payload.repoPath.trim() : '';
        const task = typeof payload.task === 'string' ? payload.task.trim() : '';
        const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
        const callId = typeof payload.callId === 'string' ? payload.callId.trim() : '';
        if (!repoId || !repoPath || !task || task.length > 4_000 || !sessionId || !callId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accepted: false, error: 'repoId, repoPath, task, sessionId, and callId are required' }));
          return;
        }

        const owner = currentSymonOwner(sessionId);
        const call = symonToolTracker.get(sessionId, callId);
        const callRepoId = call?.args?.repoId;
        const callRepoPath = call?.args?.repoPath;
        if (!owner || !call || call.tool !== 'o8_delegate'
          || callRepoId !== repoId || callRepoPath !== repoPath
          || owner.route.scope.repoId !== repoId || owner.route.scope.repoPath !== repoPath) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accepted: false, error: 'stale or mismatched Symon delegate scope' }));
          return;
        }

        const repo = await findRepoByLocalPath(repoPath);
        if (!repo || repo.id !== repoId || resolve(repo.localPath) !== resolve(repoPath)) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accepted: false, error: 'repository registration changed' }));
          return;
        }

        const taskId = `symon-delegate-${randomUUID()}`;
        enqueueOrchestratorAutoMessage(repoPath, task, 'Symon delegate', {
          sessionId,
          callId,
          taskId,
        });
        const orchestratorSession = getActiveOrchestratorBackend().peekSession(repoPath);
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          accepted: true,
          taskId,
          requestId: taskId,
          sessionId: orchestratorSession?.sessionName ?? null,
          note: orchestratorSession?.status === 'busy' ? 'queued behind the active repo turn' : 'queued',
        }));
      })().catch((error) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ accepted: false, error: error instanceof Error ? error.message : 'delegate enqueue failed' }));
      });
    });
    return;
  }

  // Background Claude tasks call this loopback-only bridge after their existing
  // dock event and task-ledger write. No active phone session means no-op fanout.
  if (req.url === '/symon-task-complete' && req.method === 'POST') {
    if (!isAuthorizedInternalRequest(req)) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      let payload: Partial<SymonTaskCompletePayload>;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Partial<SymonTaskCompletePayload>;
      } catch {
        res.writeHead(400);
        res.end('invalid json');
        return;
      }
      if (
        typeof payload.taskId !== 'string' ||
        (payload.status !== 'done' && payload.status !== 'failed') ||
        typeof payload.intentText !== 'string' ||
        typeof payload.resultText !== 'string' ||
        typeof payload.truncated !== 'boolean'
      ) {
        res.writeHead(400);
        res.end('invalid task completion payload');
        return;
      }
      const delivered = pushSymonTaskComplete(payload as SymonTaskCompletePayload);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, delivered }));
    });
    return;
  }

  if (req.url?.startsWith('/terminal-alive') && req.method === 'GET') {
    if (!isAuthorizedInternalRequest(req)) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }
    const parsed = new URL(req.url, `http://127.0.0.1:${WS_PORT}`);
    const sessionName = parsed.searchParams.get('session') ?? '';
    const alive = sessionName
      ? terminalAttachments.has(sessionName) || tmuxSessionExists(sessionName)
      : false;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ alive }));
    return;
  }

  if (req.url === '/terminal-signal' && req.method === 'POST') {
    if (!isAuthorizedInternalRequest(req)) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      let payload: InternalTerminalSignalPayload = {};
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as InternalTerminalSignalPayload;
      } catch {
        res.writeHead(400);
        res.end('invalid json');
        return;
      }

      const sessionName = payload?.sessionName?.trim();
      const signal = payload?.signal?.trim() || 'SIGTERM';
      if (!sessionName) {
        res.writeHead(400);
        res.end('sessionName required');
        return;
      }

      try {
        terminateTerminalSession(sessionName, signal);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to signal terminal session' }));
      }
    });
    return;
  }

  if (req.url === '/terminal-exec' && req.method === 'POST') {
    if (!isAuthorizedInternalRequest(req)) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      let payload: { sessionName?: string; command?: string } | null = null;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { sessionName?: string; command?: string };
      } catch {
        res.writeHead(400);
        res.end('invalid json');
        return;
      }

      const sessionName = payload?.sessionName?.trim();
      const command = payload?.command;
      if (!sessionName || !command) {
        res.writeHead(400);
        res.end('sessionName and command required');
        return;
      }

      const attachment = terminalAttachments.get(sessionName);
      if (!attachment) {
        res.writeHead(404);
        res.end('session not found');
        return;
      }

      try {
        // PTY raw-mode TUIs (like Claude Code) interpret \r as Enter, not \n
        attachment.ptyProcess.write(`${command}\r`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to write to terminal' }));
      }
    });
    return;
  }

  if (req.url?.startsWith('/terminal-scrollback') && req.method === 'GET') {
    if (!isAuthorizedInternalRequest(req)) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }

    const url = new URL(req.url, `http://127.0.0.1:${WS_PORT}`);
    const sessionName = url.searchParams.get('sessionName')?.trim();
    if (!sessionName) {
      res.writeHead(400);
      res.end('sessionName required');
      return;
    }

    const attachment = terminalAttachments.get(sessionName);
    if (!attachment) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'session not found' }));
      return;
    }

    const scrollback = attachment.scrollbackChunks.join('');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ scrollback }));
    return;
  }

  // ── Supervisor watch endpoint ──
  if (req.url === '/supervisor/watch' && req.method === 'POST') {
    if (!isAuthorizedInternalRequest(req)) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
          surfaceId?: string;
          repoPath?: string;
          name?: string;
          prompt?: string;
        };
        if (!body.surfaceId || !body.repoPath) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'surfaceId and repoPath required' }));
          return;
        }
        registerWatchedAgent(
          body.surfaceId,
          body.repoPath,
          body.name ?? 'Unnamed agent',
          body.prompt ?? '',
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, watching: body.surfaceId }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
      }
    });
    return;
  }

  // #1523 — push-based completion. The owned-session store POSTs here when a
  // worker child exits clean, so agent_completed no longer depends on a poll
  // catching the dead session in a transient 'reviewing' snapshot before the
  // session_lost grace / orphan sweep / salvage nets get to it. If the watch
  // registration was lost (its 3s best-effort fetch can time out under load),
  // re-register from the lane row and drive the same chain.
  if (req.url === '/supervisor/completed' && req.method === 'POST') {
    if (!isAuthorizedInternalRequest(req)) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      void (async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { surfaceId?: string };
          const surfaceId = typeof body.surfaceId === 'string' ? body.surfaceId.trim() : '';
          if (!surfaceId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'surfaceId required' }));
            return;
          }

          let ingested = await ingestAgentCompletionSignal(surfaceId);
          if (!ingested) {
            const { findLaneBySession } = await import('@/lib/lane/registry');
            const lane = findLaneBySession(surfaceId);
            if (lane && !isTerminalLaneStatus(lane.status)) {
              registerWatchedAgent(surfaceId, lane.repoPath, lane.label || lane.branch, '');
              ingested = await ingestAgentCompletionSignal(surfaceId);
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ingested }));
        } catch (err) {
          console.error('[supervisor] completion-signal ingest failed:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'ingest failed' }));
        }
      })();
    });
    return;
  }

  // ── Orchestrator reload broadcast ──
  // Invoked by /api/orchestrator/reload after a conversational MCP install
  // (via cortex.register_mcp). Aborts any in-flight turn for the repo so the
  // next user message spawns fresh, then fans out a `notice` event to every
  // orchestrator subscriber so the UI can render its reload banner.
  if (req.url === '/internal/orchestrator-reload' && req.method === 'POST') {
    if (!isAuthorizedInternalRequest(req)) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
          repoPath?: string;
          message?: string;
          registered?: unknown;
          noticeId?: string;
        };
        const repoPath = resolveOrchestratorRepoPath(typeof body.repoPath === 'string' ? body.repoPath : null);
        if (!repoPath) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'repoPath required' }));
          return;
        }

        const registered = Array.isArray(body.registered)
          ? body.registered.filter((entry): entry is string => typeof entry === 'string')
          : [];
        const noticeMessage = typeof body.message === 'string' && body.message.trim()
          ? body.message.trim()
          : registered.length > 0
            ? `Reloading with new MCP tools: ${registered.join(', ')}…`
            : 'Reloading with new MCP tools…';
        const noticeId = typeof body.noticeId === 'string' && body.noticeId.trim()
          ? body.noticeId.trim()
          : `mcp-reload-${Date.now()}`;

        // Abort any in-flight turn (any backend) so the next user message
        // respawns with the latest MCP config. We don't null claudeSessionId —
        // the next turn passes `--resume <id>` and the transcript stays intact.
        let aborted = false;
        for (const [key, controller] of orchestratorInflightAborts) {
          if (!key.startsWith(`${repoPath}::`)) continue;
          if (controller.signal.aborted) continue;
          controller.abort();
          aborted = true;
        }
        if (aborted) {
          console.log(`[ws-server] orchestrator-reload aborted in-flight turn(s) for ${repoPath}`);
        }

        // Broadcast a `notice` event to every orchestrator subscriber for
        // this repo. The UI hook renders a short-lived banner.
        const payload = JSON.stringify({
          channel: 'orchestrator',
          event: 'notice',
          data: {
            repoPath,
            kind: 'mcp-reload',
            noticeId,
            message: noticeMessage,
            registered,
          },
        });
        let delivered = 0;
        for (const sub of orchestratorSubscriptions.values()) {
          if (sub.repoPath !== repoPath) continue;
          const c = clients.get(sub.clientId);
          if (c) {
            sendRaw(c, payload);
            delivered += 1;
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          repoPath,
          sessionName: null,
          aborted,
          delivered,
          noticeId,
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : 'invalid json',
        }));
      }
    });
    return;
  }

  if (req.url === '/internal/realtime' && req.method === 'POST') {
    if (!isAuthorizedInternalRequest(req)) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      let payload: RealtimeInternalRequest | null = null;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as RealtimeInternalRequest;
      } catch {
        res.writeHead(400);
        res.end('invalid json');
        return;
      }

      if (!payload) {
        res.writeHead(400);
        res.end('missing payload');
        return;
      }

      if (payload.kind === 'mutation') {
        if (!payload.mutation || typeof payload.mutation !== 'object') {
          res.writeHead(400);
          res.end('missing mutation');
          return;
        }
        const event = buildRealtimeEnvelope(
          'global',
          'mutation',
          payload.mutation.status === 'pending' ? 'mutation.record' : 'mutation.settled',
          { mutation: payload.mutation },
          {
            entityId: payload.mutation.surfaceId ?? payload.mutation.sessionKey ?? payload.mutation.mutationId,
            health: { state: 'live' },
          },
        );
        broadcastRealtimeEvents([event]);
        const laneLifecyclePayload = mutationToLaneLifecyclePayload(payload.mutation);
        if (laneLifecyclePayload) {
          broadcast({ channel: 'lane-lifecycle', event: 'update', data: laneLifecyclePayload });
          for (const action of symonAsyncActionTracker.settleLane(laneLifecyclePayload, Date.now())) {
            const owner = currentSymonOwner(action.sessionId);
            if (owner) pushSymonActionComplete(owner.route.clientId, action);
          }
          console.log(`[lane-lifecycle] Broadcast ${laneLifecyclePayload.laneId} ${laneLifecyclePayload.previousStatus ?? 'new'} -> ${laneLifecyclePayload.status}`);
        }

        if (payload.refreshTargets?.includes('global')) {
          scheduleRealtimeRuntimeRefresh({ fresh: payload.fresh, reason: payload.mutation.action });
        }
        if (payload.refreshTargets?.includes('mobileInbox')) {
          scheduleRealtimeMobileInboxRefresh(250, Boolean(payload.fresh));
        }
        if (payload.refreshTargets?.includes('sessionHistory')) {
          for (const sessionKey of payload.sessionKeys ?? []) {
            scheduleRealtimeSessionHistoryRefresh(sessionKey, true);
          }
        }

        res.writeHead(202);
        res.end('accepted');
        return;
      }

      if (payload.kind === 'refresh') {
        if (!Array.isArray(payload.targets)) {
          res.writeHead(400);
          res.end('missing targets');
          return;
        }
        if (payload.targets.includes('global')) {
          scheduleRealtimeRuntimeRefresh({ fresh: payload.fresh, reason: payload.reason });
        }
        if (payload.targets.includes('mobileInbox')) {
          scheduleRealtimeMobileInboxRefresh(250, Boolean(payload.fresh));
        }
        if (payload.targets.includes('sessionHistory')) {
          for (const sessionKey of payload.sessionKeys ?? []) {
            scheduleRealtimeSessionHistoryRefresh(sessionKey, Boolean(payload.fresh));
          }
        }

        res.writeHead(202);
        res.end('accepted');
        return;
      }

      res.writeHead(400);
      res.end('unsupported kind');
    });
    return;
  }

  if (req.url === '/internal/packet-tail' && req.method === 'POST') {
    if (!isAuthorizedInternalRequest(req)) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      let payload: unknown = null;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      } catch {
        res.writeHead(400);
        res.end('invalid json');
        return;
      }

      if (!isPacketTailEvent(payload)) {
        res.writeHead(400);
        res.end('invalid packet tail event');
        return;
      }

      broadcastPacketTailEvent(payload);
      res.writeHead(202);
      res.end('accepted');
    });
    return;
  }

  // ── #840 — Cortex memory change broadcast ──
  // Invoked by `publishCortexChange()` after a directive trailer is appended
  // (or any other Cortex memory write). Fans out a `cortex-changes` channel
  // event; the desktop WS bridge converts it to an `o8:cortex-changes`
  // window event so the Recall Card / Packet Review Card re-fetch without
  // a full page reload.
  if (req.url === '/internal/cortex-changes' && req.method === 'POST') {
    if (!isAuthorizedInternalRequest(req)) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
          scope?: string;
          repoPath?: string;
          reason?: string;
        };
        const scope = typeof body.scope === 'string' ? body.scope : 'unknown';
        broadcast({
          channel: 'cortex-changes',
          event: 'update',
          data: {
            scope,
            repoPath: body.repoPath ?? null,
            reason: body.reason ?? null,
            ts: currentIsoTime(),
          },
        });
        console.log(`[cortex-changes] Broadcast scope=${scope}${body.reason ? ` reason=${body.reason}` : ''}`);
        res.writeHead(202);
        res.end('accepted');
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : 'invalid json',
        }));
      }
    });
    return;
  }

  // ── #1147 Phase 2 — live visual-proof broadcast ──
  // Invoked by `publishArtifactRecorded()` after an agent records a
  // before/after still. Fans out an `artifacts` channel event; the desktop WS
  // bridge converts it to an `o8:artifacts` window event so the mounted proof
  // strips (PacketCard / PrPanel / mission-complete) refetch live. DURABLE —
  // missing a proof event would leave a stale strip until the next fetch.
  if (req.url === '/internal/artifacts' && req.method === 'POST') {
    if (!isAuthorizedInternalRequest(req)) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
          artifactId?: string;
          packetId?: string | null;
          prNumber?: number | null;
          laneId?: string | null;
        };
        broadcast({
          channel: 'artifacts',
          event: 'recorded',
          data: {
            artifactId: typeof body.artifactId === 'string' ? body.artifactId : null,
            packetId: body.packetId ?? null,
            prNumber: typeof body.prNumber === 'number' ? body.prNumber : null,
            laneId: body.laneId ?? null,
            ts: currentIsoTime(),
          },
        });
        console.log(`[artifacts] Broadcast recorded packet=${body.packetId ?? '-'} pr=${body.prNumber ?? '-'}`);
        res.writeHead(202);
        res.end('accepted');
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : 'invalid json',
        }));
      }
    });
    return;
  }

  // ── Mobile dev-host URL push ──
  // Invoked by /api/mobile/push-url after a desktop user long-presses a port
  // chip and clicks "Send to mobile". Fans out a one-shot `mobile-dev-host`
  // event to every WS client; the mobile-split-shell listener then dispatches
  // the matching `o8:mobile-url-push` window CustomEvent for DevHostFrame.
  if (req.url === '/internal/mobile-url-push' && req.method === 'POST') {
    if (!isAuthorizedInternalRequest(req)) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
          url?: string;
          sourceRepoId?: string | null;
          sentAt?: string;
        };
        const url = typeof body.url === 'string' ? body.url.trim() : '';
        if (!url) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'url required' }));
          return;
        }
        const sentAt = typeof body.sentAt === 'string' && body.sentAt.trim()
          ? body.sentAt
          : currentIsoTime();
        const sourceRepoId = typeof body.sourceRepoId === 'string' && body.sourceRepoId.trim()
          ? body.sourceRepoId.trim()
          : null;

        // Count active clients before broadcasting so the desktop toast can
        // tell the user "no phone connected" without depending on PWA pings.
        const recipients = clients.size;
        broadcast({
          channel: 'mobile-dev-host',
          event: 'url-push',
          data: { url, sentAt, sourceRepoId },
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, recipients, sentAt }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : 'invalid json',
        }));
      }
    });
    return;
  }

  // Health check endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(buildWsHealthPayload(INSTANCE_IDENTITY, {
      clients: clients.size,
      eventLoop: wsWatchdog.getStats(),
    })));
    return;
  }
  res.writeHead(404);
  res.end();
});

const WS_TOKEN = getOrCreateWsToken();
console.log(`[ws-auth] WS token loaded (source: ${process.env.WS_TOKEN ? 'env' : WS_TOKEN_PATH})`);

const wss = new WebSocketServer({
  server: httpServer,
  path: '/ws',
  perMessageDeflate: {
    zlibDeflateOptions: { level: 1 }, // fast compression — good enough for JSON
    threshold: 128, // only compress messages > 128 bytes
  },
  verifyClient: (info, done) => {
    const url = new URL(info.req.url ?? '', `http://${info.req.headers.host}`);
    const token = url.searchParams.get('token') ?? '';
    const req = info.req as typeof info.req & {
      __o8Device?: MobileDevice | null;
      __o8AuthKind?: 'operator' | 'device';
      __o8Remote?: boolean;
      __o8RevokedClose?: boolean;
    };
    // Remote vs loopback (drives whether E2EE is offered) — socket peer truth.
    req.__o8Remote = !isLoopbackAddress(req.socket?.remoteAddress ?? '127.0.0.1');
    req.__o8Device = null;
    if (wsTokenMatches(token)) {
      req.__o8AuthKind = 'operator';
      done(true);
      return;
    }
    // Per-device token (#5) — accept an active (non-revoked) enrolled device, and
    // stash it so the connection handler can offer the E2EE handshake. Additive:
    // a no-op until a device enrolls; the shared token above keeps the desktop
    // webview + legacy phones working.
    try {
      const device = token ? resolveDeviceByToken(token) : null;
      if (device) {
        req.__o8Device = device;
        req.__o8AuthKind = 'device';
        done(true);
        return;
      }
      // Known-but-REVOKED token → accept the upgrade, then close 4401 immediately
      // (handled in the connection handler) so the phone gets a deterministic
      // "revoked" signal on reconnect, not an ambiguous upgrade failure.
      if (token && isTokenRevoked(token)) {
        req.__o8RevokedClose = true;
        done(true);
        return;
      }
    } catch {
      // DB not ready / lookup error → fall through to reject.
    }
    done(false, 401, 'Unauthorized');
  },
});

// The httpServer has its own 'error' handler (stale-port recovery below), but the
// WebSocketServer can emit 'error' independently (e.g. during upgrade handling).
// Without a listener that's an uncaughtException that kills every connected client.
wss.on('error', (err) => {
  console.error('[ws-server] WebSocketServer error (non-fatal):', err);
});

wss.on('connection', (ws, req) => {
  const upgrade = req as typeof req & {
    __o8Device?: MobileDevice | null;
    __o8AuthKind?: 'operator' | 'device';
    __o8Remote?: boolean;
    __o8RevokedClose?: boolean;
  };
  // #5 — a revoked token was accepted only to deliver a clean 4401 close. Send it
  // and drop the socket without registering a client (no data is ever exchanged).
  if (upgrade.__o8RevokedClose) {
    try { ws.close(4401, 'device revoked'); } catch { /* already gone */ }
    return;
  }
  const device = upgrade.__o8Device ?? null;
  const authKind = upgrade.__o8AuthKind;
  if (!authKind) {
    try { ws.close(4401, 'missing authenticated subject'); } catch { /* already gone */ }
    return;
  }
  const remote = upgrade.__o8Remote === true;
  const client: ClientState = {
    id: randomUUID(),
    ws,
    sessionKey: null,
    inboxEtag: null,
    lastHistoryId: null,
    alive: true,
    terminalSessions: new Set(),
    realtimeSubscriptions: [],
    realtimeCapabilities: new Set(),
    packetTailSubscriptions: new Set(),
    backpressureQueue: [],
    flushTimer: null,
    deviceId: device?.id ?? null,
    authKind,
  };

  clients.set(client.id, client);
  console.log(`[ws-server] Client connected: ${client.id} (${clients.size} total)`);

  // Send welcome with connection info (plaintext — precedes any E2EE handshake)
  send(client, {
    channel: 'system',
    event: 'connected',
    data: {
      clientId: client.id,
      gateway: 'disabled',
      realtimeSeq,
      instanceId: INSTANCE_IDENTITY.instanceId,
      bootId: INSTANCE_IDENTITY.bootId,
    },
  });

  // #5 — a REMOTE per-device-token client gets the E2EE handshake offered; its
  // initial state is withheld until the channel is encrypted (or falls back to
  // plaintext). Loopback + legacy (shared-token) clients get it now, unchanged.
  if (remote && device) {
    initiateE2eeHandshake(client, device);
  } else {
    sendInitialClientState(client);
  }
  startBrowserDiscoveryRealtimeLoop();

  ws.on('message', (raw) => {
    handleClientMessage(client, typeof raw === 'string' ? raw : raw.toString());
  });

  ws.on('pong', () => { client.alive = true; });

  ws.on('close', () => {
    // Stop backpressure flush timer
    stopFlushTimer(client);
    if (client.e2ee?.helloTimer) clearTimeout(client.e2ee.helloTimer);
    client.backpressureQueue.length = 0;
    // Detach from all terminal sessions
    for (const sessionName of client.terminalSessions) {
      removeClientFromTerminal(client.id, sessionName);
    }
    // Clean up orchestrator subscriptions (one per backend the client used).
    for (const key of orchestratorSubscriptions.keys()) {
      if (key.startsWith(`${client.id}::`)) orchestratorSubscriptions.delete(key);
    }
    // Drop any Symon Agent Mode session this socket hosted.
    cleanupSymonForClient(client.id);
    clients.delete(client.id);
    console.log(`[ws-server] Client disconnected: ${client.id} (${clients.size} total)`);
  });

  ws.on('error', (err) => {
    console.error(`[ws-server] Client error ${client.id}:`, err.message);
  });
});

// Keepalive ping
setInterval(() => {
  for (const client of clients.values()) {
    if (!client.alive) {
      stopFlushTimer(client);
      client.ws.terminate();
      clients.delete(client.id);
      continue;
    }
    client.alive = false;
    client.ws.ping();
  }
}, PING_INTERVAL_MS);

// #5 — revoke-disconnect sweep. Revocation drops a device from the HTTP gate
// immediately (the token-hash file) and refuses its next WS reconnect; this
// closes a still-LIVE WS within ~20s so an open mobile session can't linger.
setInterval(() => {
  for (const client of clients.values()) {
    if (!client.deviceId) continue;
    try {
      if (!isDeviceActive(client.deviceId)) {
        console.log(`[mobile-e2ee] closing revoked device connection ${client.id} (device ${client.deviceId})`);
        try { client.ws.close(4401, 'device revoked'); } catch { /* already gone */ }
      }
    } catch { /* DB hiccup — try again next sweep */ }
  }
}, 20_000);

// ── Git watcher — push diff stats + file changes on changes ──

const REPO_ROOT = resolve(process.env.CORTEX_IDE_REVIEW_REPO_ROOT || process.cwd());
const GIT_DIR = resolve(REPO_ROOT, '.git');
let lastDiffHash = '';
let diffDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let reviewPollTimer: ReturnType<typeof setInterval> | null = null;
const reviewTargetHashes = new Map<string, string>();
const REVIEW_POLL_INTERVAL_MS = 10_000;
const REVIEW_SCAN_CONCURRENCY = 3;
let reviewRefreshInFlight = false;
let reviewRefreshRerequest = false;

async function pruneOrphanedCodexWorktreeBranches(repoPath: string): Promise<number> {
  // `git worktree prune` only removes admin entries for deleted git-worktree
  // dirs. APFS clones in .cortex-worktrees/ aren't git worktrees of repoPath
  // (each clone has its own .git), so prune ignores them — and occasionally
  // fails for unrelated reasons (lock contention, transient git state). Don't
  // let a prune failure block the branch cleanup; that's the actually useful
  // work in this function.
  try {
    await execFileAsync('git', ['worktree', 'prune'], {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 10_000,
    });
  } catch (error) {
    console.warn(
      `[cleanup] git worktree prune failed (continuing with branch cleanup): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Match BOTH legacy worktree branches (from pre-F2/F8 dispatches) AND the
  // current `inline/*` branches that lane dispatch creates inside APFS clones.
  // Anything not bound to a live worktree is fair game — the lane-side branch
  // is owned by its clone's .git, not by repoPath, so deleting it from
  // repoPath only removes the repo-side ref (clones keep their own).
  const [{ stdout: worktreeStdout }, branchOuts] = await Promise.all([
    execFileAsync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 10_000,
    }),
    Promise.all([
      execFileAsync('git', ['branch', '--list', 'worktree/codex/*', '--format=%(refname:short)'], {
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: 10_000,
      }).catch(() => ({ stdout: '' })),
      execFileAsync('git', ['branch', '--list', 'worktree/*/*', '--format=%(refname:short)'], {
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: 10_000,
      }).catch(() => ({ stdout: '' })),
    ]),
  ]);

  const activeBranches = new Set(
    parseGitWorktreeList(worktreeStdout)
      .filter((worktree) => worktree.branch && existsSync(worktree.path))
      .map((worktree) => worktree.branch as string),
  );

  const orphanedBranches = Array.from(new Set(
    branchOuts
      .flatMap((out) => out.stdout.split('\n'))
      .map((branch) => branch.trim())
      .filter(Boolean)
      .filter((branch) => !activeBranches.has(branch)),
  ));

  for (const branch of orphanedBranches) {
    await execFileAsync('git', ['branch', '-D', branch], {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 10_000,
    }).catch((error) => {
      console.warn(
        `[cleanup] failed to delete branch ${branch}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  console.log(`[cleanup] Pruned ${orphanedBranches.length} orphaned worktree branches`);
  return orphanedBranches.length;
}

async function getReviewWatchTargets() {
  const repoPaths = new Set<string>([REPO_ROOT]);
  for (const p of await listRepoPaths()) {
    repoPaths.add(resolve(p));
  }

  const targets = [] as Array<{ repoPath: string; workspacePath: string; sessionKey?: string }>;

  for (const repoPath of repoPaths) {
    targets.push({ repoPath, workspacePath: repoPath });

    try {
      for (const worktreeBase of resolveWorktreeRootLayout(repoPath).bases) {
        const metaPath = resolve(worktreeBase, '.meta.json');
        if (!(await pathExists(metaPath))) continue;
        const raw = await readFile(metaPath, 'utf-8');
        const meta = JSON.parse(raw) as {
          worktrees?: Record<string, { id: string; sessionKey?: string; claudeManaged?: boolean }>;
        };
        for (const worktree of Object.values(meta.worktrees ?? {})) {
          const workspacePath = worktree.claudeManaged
            ? resolve(repoPath, '.claude', 'worktrees', worktree.id)
            : resolve(worktreeBase, worktree.id);
          if (!(await pathExists(workspacePath))) continue;
          targets.push({
            repoPath,
            workspacePath,
            sessionKey: worktree.sessionKey,
          });
        }
      }
    } catch {
      // Ignore repos without a readable worktree store
    }
  }

  return targets;
}

function broadcastDiffStats() {
  if (!hasReviewSubscribers()) return;

  execFile('sh', ['-c', 'git diff --shortstat origin/main..HEAD 2>/dev/null; git diff --shortstat 2>/dev/null'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: 5000,
  }, (err, stdout) => {
    if (err || !stdout) return;
    const stat = stdout.trim();

    let additions = 0, deletions = 0, files = 0;
    for (const line of stat.split('\n').filter(Boolean)) {
      const fm = line.match(/(\d+) files? changed/);
      const am = line.match(/(\d+) insertions?\(\+\)/);
      const dm = line.match(/(\d+) deletions?\(-\)/);
      if (fm) files += parseInt(fm[1]);
      if (am) additions += parseInt(am[1]);
      if (dm) deletions += parseInt(dm[1]);
    }

    const hash = `${additions}:${deletions}:${files}`;
    if (hash === lastDiffHash) return;
    lastDiffHash = hash;

    broadcast({ channel: 'review', event: 'diff-stats', data: { kind: 'diff-stats', additions, deletions, files } });
  });
}

// #1484 — incremental review scan. The 10s poll used to run a git change-set
// probe against EVERY repo + EVERY worktree on every tick even when nothing
// changed. Now: fs-watchers mark specific workspaces dirty; clean targets are
// stat-gated on their .git HEAD+index mtimes (commits/stage churn) and
// skipped; a 60s full sweep catches what neither signal covers (unstaged-only
// edits in unwatched repos, worktrees whose .git is a pointer file). The
// REPO_ROOT target always scans — its own unstaged edits are the Workspace
// panel's live diff and carry no watcher signal.
const reviewDirtyWorkspaces = new Set<string>();
const reviewTargetScanMeta = new Map<string, string>();
const REVIEW_FULL_SWEEP_MS = 60_000;
let lastReviewFullSweepAt = 0;

function markReviewWorkspaceDirty(base: string, filename: string | null): void {
  if (!filename) return;
  const firstSegment = filename.split(/[\\/]/, 1)[0];
  if (!firstSegment) return;
  reviewDirtyWorkspaces.add(resolve(base, firstSegment));
}

// Adversarial F5 — in a `git worktree` checkout, `.git` is a FILE containing
// a `gitdir: <path>` pointer, not a directory. Stat'ing `<file>/HEAD` throws,
// so every worktree target resolved to a constant 'x|x' key and the stat-gate
// was permanently inert (stale diffs until the 60s full sweep). Resolve the
// real gitdir through the pointer, cached per workspace (the pointer never
// changes for a live worktree).
const reviewGitDirCache = new Map<string, string>();

async function resolveReviewGitDir(workspacePath: string): Promise<string> {
  const cached = reviewGitDirCache.get(workspacePath);
  if (cached) return cached;
  const dotGit = resolve(workspacePath, '.git');
  let gitDir = dotGit;
  try {
    const info = await stat(dotGit);
    if (info.isFile()) {
      const pointer = await readFile(dotGit, 'utf8');
      const match = pointer.match(/^gitdir:\s*(.+)\s*$/m);
      if (match?.[1]) {
        const target = match[1].trim();
        gitDir = isAbsolute(target) ? target : resolve(workspacePath, target);
      }
    }
  } catch {
    // Missing .git — keep the default; stat below reports 'x' honestly.
  }
  reviewGitDirCache.set(workspacePath, gitDir);
  if (reviewGitDirCache.size > 300) {
    const oldest = reviewGitDirCache.keys().next().value;
    if (oldest !== undefined) reviewGitDirCache.delete(oldest);
  }
  return gitDir;
}

async function reviewTargetStatKey(workspacePath: string): Promise<string> {
  const gitDir = await resolveReviewGitDir(workspacePath);
  const parts = await Promise.all(['HEAD', 'index'].map(async (name) => {
    try {
      const info = await stat(resolve(gitDir, name));
      return `${info.size}:${info.mtimeMs}`;
    } catch {
      return 'x';
    }
  }));
  return parts.join('|');
}

async function broadcastReviewFileChanges() {
  if (!hasReviewSubscribers()) return;

  const targets = await getReviewWatchTargets();
  const liveTargetKeys = new Set(targets.map((target) => target.workspacePath));

  for (const key of [...reviewTargetHashes.keys()]) {
    if (!liveTargetKeys.has(key)) {
      reviewTargetHashes.delete(key);
      // F20 — the stat-gate maps grow with worktree churn unless pruned with
      // their target.
      reviewTargetScanMeta.delete(key);
      reviewDirtyWorkspaces.delete(key);
      reviewGitDirCache.delete(key);
    }
  }

  const now = Date.now();
  const fullSweep = now - lastReviewFullSweepAt >= REVIEW_FULL_SWEEP_MS;
  if (fullSweep) lastReviewFullSweepAt = now;

  let nextIndex = 0;
  const scanTarget = async (target: typeof targets[number]) => {
    try {
      const isRoot = resolve(target.workspacePath) === REPO_ROOT;
      const statKey = await reviewTargetStatKey(target.workspacePath);
      if (!fullSweep && !isRoot && !reviewDirtyWorkspaces.has(target.workspacePath)) {
        if (reviewTargetScanMeta.get(target.workspacePath) === statKey) return;
      }
      reviewDirtyWorkspaces.delete(target.workspacePath);
      reviewTargetScanMeta.set(target.workspacePath, statKey);
      const summary = await getLiveReviewChangeSet(target.workspacePath, target.repoPath, target.sessionKey);
      const hash = JSON.stringify(summary.changedFiles.map((file) => [
        file.path,
        file.status,
        file.additions ?? null,
        file.deletions ?? null,
      ]));

      if (reviewTargetHashes.get(target.workspacePath) === hash) {
        return;
      }
      reviewTargetHashes.set(target.workspacePath, hash);

      broadcast({
        channel: 'review',
        event: 'file-changes',
        data: {
          kind: 'file-changes',
          repoPath: shortHome(summary.repoPath),
          workspacePath: shortHome(summary.workspacePath),
          sessionKey: summary.sessionKey,
          additions: summary.additions,
          deletions: summary.deletions,
          files: summary.files,
          changedFiles: summary.changedFiles,
        },
      });

      if (resolve(target.workspacePath) === REPO_ROOT) {
        const rootHash = `${summary.additions}:${summary.deletions}:${summary.files}`;
        if (rootHash !== lastDiffHash) {
          lastDiffHash = rootHash;
          broadcast({
            channel: 'review',
            event: 'diff-stats',
            data: {
              kind: 'diff-stats',
              additions: summary.additions,
              deletions: summary.deletions,
              files: summary.files,
            },
          });
        }
      }
    } catch {
      // Ignore transient git failures on disappearing worktrees
    }
  };

  const workers = Array.from({ length: Math.min(REVIEW_SCAN_CONCURRENCY, targets.length) }, async () => {
    while (nextIndex < targets.length) {
      const target = targets[nextIndex];
      nextIndex += 1;
      if (!target) continue;
      await scanTarget(target);
    }
  });
  await Promise.all(workers);
}

function hasReviewSubscribers() {
  for (const client of clients.values()) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    if (client.realtimeSubscriptions.some((subscription) => subscription.stream === 'global')) return true;
  }
  return false;
}

async function runCoalescedReviewRefresh() {
  if (reviewRefreshInFlight) {
    reviewRefreshRerequest = true;
    return;
  }
  reviewRefreshInFlight = true;
  try {
    do {
      reviewRefreshRerequest = false;
      await broadcastReviewFileChanges();
      broadcastDiffStats();
      scheduleRealtimeRuntimeRefresh({ reason: 'review.refresh', fresh: true });
      scheduleRealtimeMobileInboxRefresh(250, true);
    } while (reviewRefreshRerequest);
  } finally {
    reviewRefreshInFlight = false;
  }
}

function scheduleReviewRefresh(delayMs = 500) {
  if (diffDebounceTimer) clearTimeout(diffDebounceTimer);
  diffDebounceTimer = setTimeout(() => {
    diffDebounceTimer = null;
    void runCoalescedReviewRefresh();
  }, delayMs);
}

// Worktree working trees. Agents write files long before they stage them, so
// the .git refs/index watchers alone would miss work in progress — this is the
// signal that lets the conflict probe be event-driven instead of polled.
//
// Recursive fs.watch is FSEvents-backed on macOS (the shipping platform):
// kernel-coalesced, O(1) to establish, and it does not walk the tree. Idempotent
// and re-runnable, because worktree base dirs are created lazily on first
// dispatch and may not exist at boot.
const watchedWorktreeBases = new Set<string>();

function ensureWorktreeWatchers(extraRepoPaths: string[] = []) {
  // #1484 — watch every registered repo's worktree bases, not just the root
  // repo's: dispatched workers live in other repos' .cortex-worktrees and
  // their edits should mark the review scan dirty the same way. FSEvents
  // recursive watches are kernel-coalesced and O(1) to establish per base.
  const repoPaths = new Set([REPO_ROOT, ...extraRepoPaths.map((repoPath) => resolve(repoPath))]);
  const bases: string[] = [];
  for (const repoPath of repoPaths) {
    bases.push(...resolveWorktreeRootLayout(repoPath).bases);
    bases.push(resolve(repoPath, '.claude', 'worktrees'));
  }
  for (const base of bases) {
    if (watchedWorktreeBases.has(base) || !existsSync(base)) continue;
    try {
      watch(base, { recursive: true }, (_event, filename) => {
        // A known-noisy path (node_modules, .next, target...) tells us nothing.
        // An UNKNOWN path is treated as real — fail safe, never fail silent.
        if (isWorktreeNoise(filename)) return;
        markConflictsDirty();
        markReviewWorkspaceDirty(base, filename ?? null);
      }).on('error', (err) => {
        // Lost the signal — fall back to unconditional polling rather than go
        // blind. Never worse than the behaviour this replaced.
        console.warn('[ws-server] worktree watcher error, reverting to polling:', err);
        conflictWatchersActive = false;
        watchedWorktreeBases.delete(base);
      });
      watchedWorktreeBases.add(base);
      conflictWatchersActive = true;
      console.log(`[ws-server] Watching worktrees at ${base} for conflict changes`);
    } catch (err) {
      console.warn(`[ws-server] could not watch ${base}, reverting to polling:`, err);
      conflictWatchersActive = false;
    }
  }
}

// Watch .git directory for changes (commits, merges, rebases)
if (existsSync(GIT_DIR)) {
  // Watch refs (branch tips change on commit/push)
  const refsDir = resolve(GIT_DIR, 'refs');
  if (existsSync(refsDir)) {
    // An unhandled FSWatcher 'error' (refs pruned during rebase/gc) crashes the process.
    watch(refsDir, { recursive: true }, () => {
      markConflictsDirty();
      scheduleReviewRefresh();
    }).on('error', (err) => {
      console.warn('[ws-server] git refs watcher error:', err);
      conflictWatchersActive = false;
    });
    conflictWatchersActive = true;
  }
  // Watch index (staged files change)
  const indexFile = resolve(GIT_DIR, 'index');
  if (existsSync(indexFile)) {
    watch(indexFile, () => {
      markConflictsDirty();
      scheduleReviewRefresh();
    }).on('error', (err) => {
      console.warn('[ws-server] git index watcher error:', err);
      conflictWatchersActive = false;
    });
  }
  // Worktree metadata: HEAD/index writes for each linked worktree, plus the
  // add/remove of the worktrees themselves. Small directory, cheap to watch —
  // and a new worktree appearing is what tells us to attach its tree watcher.
  const gitWorktreesDir = resolve(GIT_DIR, 'worktrees');
  if (existsSync(gitWorktreesDir)) {
    watch(gitWorktreesDir, { recursive: true }, () => {
      markConflictsDirty();
      ensureWorktreeWatchers();
    }).on('error', (err) => {
      console.warn('[ws-server] git worktrees watcher error:', err);
      conflictWatchersActive = false;
    });
  }
  console.log(`[ws-server] Watching git at ${GIT_DIR} for diff changes`);
}

ensureWorktreeWatchers();
// A worktree base dir created after boot (first dispatch of the session) has no
// watcher yet. Re-attaching is idempotent and costs a couple of stat()s, so a
// slow re-check closes that gap without any hot-path work — and pulls in the
// registered-repo bases (#1484) once the repo list is readable.
setInterval(() => {
  void listRepoPaths()
    .then((paths) => ensureWorktreeWatchers(paths))
    .catch(() => ensureWorktreeWatchers());
}, 30_000).unref?.();

reviewPollTimer = setInterval(() => {
  scheduleReviewRefresh(0);
}, REVIEW_POLL_INTERVAL_MS);
if (reviewPollTimer.unref) reviewPollTimer.unref();

// Session preservation strategy:
// - cortex-dash-* sessions survive server restarts for reuse (findExistingDashSession).
// - On WS disconnect, a 10s grace period allows hot-reload reconnects before killing.
// - cortex-codex-*/cortex-claude-* sessions persist indefinitely (stall detector manages them).

async function recoverFromPortInUse(): Promise<void> {
  console.log(`[ws-server] Port ${WS_PORT} in use — checking listener identity before recovery`);
  const health = await fetchWsHealthIdentity(WS_PORT);
  const decision = decideStalePortRecovery(INSTANCE_IDENTITY, health);

  if (decision.action !== 'kill') {
    console.error(
      `[ws-server] Port ${WS_PORT} is occupied (${decision.reason}); refusing to kill the listener. `
      + 'Stop the process or choose another O8_WS_PORT.',
    );
    process.exit(1);
  }

  try {
    const pids = execFileSync('lsof', ['-ti', `:${WS_PORT}`, '-sTCP:LISTEN'], { encoding: 'utf-8' }).trim();
    if (pids) {
      execFileSync('kill', ['-9', ...pids.split('\n').filter(Boolean)], { encoding: 'utf-8' });
      console.log(`[ws-server] Killed stale o8 process(es): ${pids.replace(/\n/g, ', ')}`);
    } else {
      console.log(`[ws-server] Port ${WS_PORT} reported in use but no listener found — retrying`);
    }
    setTimeout(() => {
      httpServer.listen(WS_PORT, '0.0.0.0', () => {
        console.log(`[ws-server] o8 WebSocket server listening on ws://0.0.0.0:${WS_PORT}/ws`);
        wsWatchdog.start();
        startRelayConnectorIfEnabled();
        startMachineAttachSupervisor();
      });
    }, 500);
  } catch (error) {
    console.error(
      `[ws-server] Failed to clear stale o8 listener on port ${WS_PORT}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    void recoverFromPortInUse();
  } else {
    throw err;
  }
});

// Dashboard tmux sessions (cortex-dash-*) are NOT purged on startup.
// The reuse logic in handleTerminalCreate will find and reattach to them,
// and the disconnect handler gives a 10s grace period for hot-reload reconnects.
// Agent-launched sessions (cortex-codex-*, cortex-claude-*) are separately
// managed by the stall detector and lifecycle system.

async function bootstrapWsServer() {
  await waitForNextReady();

  const db = getDb();
  if (db) {
    expireStaleApprovals();
  }

  try {
    await pruneOrphanedCodexWorktreeBranches(REPO_ROOT);
  } catch (error) {
    console.warn(
      `[cleanup] Failed to prune orphaned worktree branches: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const { sweepTerminalCortexWorktrees } = await import('@/lib/lane/terminal-worktree-sweep');
    const result = await sweepTerminalCortexWorktrees(REPO_ROOT);
    if (result.removed > 0 || result.failed > 0) {
      console.log(
        `[cleanup] Startup worktree sweep scanned=${result.scanned} removed=${result.removed} skippedActive=${result.skippedActive} failed=${result.failed}`,
      );
    }
  } catch (error) {
    console.warn(
      `[cleanup] Startup worktree sweep failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const { sweepMergedPacketVerificationIncidents } = await import('@/lib/supervisor/merged-incident-resolution');
    const resolved = sweepMergedPacketVerificationIncidents({ event: 'startup_sweep' });
    if (resolved > 0) {
      console.log(`[supervisor-inbox] Startup sweep auto-resolved ${resolved} stale verification incident(s) for merged/archived packet(s)`);
    }
  } catch (error) {
    console.warn(
      `[supervisor-inbox] Startup merged/archived incident sweep failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const checkLaunchAgentHealth = async () => {
    try {
      const { surfaceLaunchAgentCrashLoops } = await import('@/lib/supervisor/launch-agent-health');
      const alerts = surfaceLaunchAgentCrashLoops();
      for (const alert of alerts) {
        console.error(`[supervisor-inbox] ${alert.failureCount} recent ${alert.label} LaunchAgent failures surfaced to the Incident Queue`);
      }
    } catch (error) {
      console.warn(
        `[supervisor-inbox] LaunchAgent health check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  await checkLaunchAgentHealth();
  setInterval(() => { void checkLaunchAgentHealth(); }, 60_000).unref();

  try {
    const { sweepPacketsMergedByAncestry } = await import('@/lib/orchestrator/merged-by-ancestry');
    const result = await sweepPacketsMergedByAncestry();
    if (result.merged > 0) {
      console.log(`[merged-by-ancestry] Startup sweep released ${result.merged} externally merged packet(s)`);
    }
  } catch (error) {
    console.warn(
      `[merged-by-ancestry] Startup sweep failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    await rehydrateOrchestratorSessions({ onReboundEvent: handleReboundOrchestratorEvent });
    const codexRebound = rehydrateCodexOrchestratorTurns({ onReboundEvent: handleReboundOrchestratorEvent });
    if (codexRebound > 0) {
      console.log(`[orchestrator-rehydrate] Re-bound ${codexRebound} Codex orchestrator turn${codexRebound === 1 ? '' : 's'}`);
    }
  } catch (error) {
    console.warn(
      `[orchestrator-rehydrate] WS startup rehydration failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const { reconcileStuckLanes, reconcileOrphanedWorktrees } = await import('@/lib/lane/reconcile');
    await reconcileStuckLanes();
    await reconcileOrphanedWorktrees();
  } catch (error) {
    console.warn(
      `[reconcile] WS startup lane reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // #534 follow-up — periodic sweep catches lanes whose worktree was deleted
  // out-of-band (orchestrator bash-merge) so the UI heals within 30s even if
  // no API caller triggers the inline reconcile. Cheap: a few existsSync
  // checks on a small set of non-terminal lanes.
  setInterval(async () => {
    try {
      const [
        { reconcileOrphanedWorktrees },
        { sweepPacketsMergedByAncestry },
      ] = await Promise.all([
        import('@/lib/lane/reconcile'),
        import('@/lib/orchestrator/merged-by-ancestry'),
      ]);
      const healed = await reconcileOrphanedWorktrees();
      const merged = await sweepPacketsMergedByAncestry();
      if (healed > 0) {
        console.log(`[reconcile] Periodic sweep healed ${healed} orphaned lane(s)`);
      }
      if (merged.merged > 0) {
        console.log(`[merged-by-ancestry] Periodic sweep released ${merged.merged} externally merged packet(s)`);
      }
    } catch (error) {
      console.warn(
        `[reconcile] Periodic orphan/merged-by-ancestry sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, 30_000).unref();

  setInterval(async () => {
    try {
      const { runRulesPromotionCycle } = await import('@/lib/dispatch/rules-promotion') as {
        runRulesPromotionCycle: (options?: { now?: Date }) => Promise<{
          promoted: number;
          demoted: number;
        }>;
      };
      const result = await runRulesPromotionCycle();
      console.log(`[rules-promotion] promoted=${result.promoted} demoted=${result.demoted}`);
    } catch (error) {
      console.warn(
        `[rules-promotion] cycle failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, 10 * 60 * 1000).unref();

  startPollingLoops();
  startBrowserDiscoveryRealtimeLoop();
  startAttachedBrowserRefreshLoop();
  scheduleRealtimeRuntimeRefresh({ reason: 'startup', fresh: false });
  scheduleRealtimeMobileInboxRefresh(500);

  httpServer.listen(WS_PORT, '0.0.0.0', () => {
    console.log(`[ws-server] o8 WebSocket server listening on ws://0.0.0.0:${WS_PORT}/ws`);

    // Begin event-loop lag sampling (#1498 follow-up).
    wsWatchdog.start();

    // Off-network connector (docs/internals/connect-contract.md). Fully
    // isolated + gated (entitlement + operator toggle + license token); dials OUT
    // to the relay and bridges relayed phones into THIS ws-server. A failure here
    // NEVER affects the LAN path — the call is self-guarded and returns null.
    startRelayConnectorIfEnabled();
    startMachineAttachSupervisor();

    // ── Start Agent Supervisor ──
    const supervisorCallbacks: SupervisorCallbacks = {
      async fetchFleetStatus() {
        // #476 — Use cached inventory (15s TTL) instead of forcing fresh discovery every 5s.
        // The supervisor only needs to detect status changes, not millisecond-fresh data.
        const snapshot = await fetchRuntimeInventorySnapshot(false);
        return (snapshot.agents ?? [])
          .filter((agent) => agent.runtime === 'codex' || agent.runtime === 'claude-code')
          .map((a) => ({
            sessionKey: a.sessionKey as string,
            status: a.status as string,
            name: a.name as string,
            workspace: a.workspace as string,
            currentTask: a.currentTask as string,
          }));
      },
      async fetchTranscript(sessionKey, limit) {
        const entries = await fetchRuntimeTranscript(sessionKey, limit);
        return entries.map((entry) => ({
          id: entry.id,
          role: entry.role,
          text: entry.text,
          timestamp: entry.timestamp,
          timestampLabel: entry.timestampLabel,
          toolName: entry.toolName,
        }));
      },
      async steerAgent(surfaceId, message) {
        const res = await fetchWithRetry(buildNextUrl('/api/runtime/action'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'steer', surfaceId, message }),
          signal: AbortSignal.timeout(8000),
        });
        const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; note?: string } | null;
        if (!res.ok || data?.ok === false) {
          throw new Error(data?.error ?? data?.note ?? `Steer failed (${res.status})`);
        }
      },
      async interruptAgent(surfaceId) {
        await fetchWithRetry(buildNextUrl('/api/runtime/action'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'interrupt', surfaceId }),
          signal: AbortSignal.timeout(8000),
        });
      },
      async relaunchAgent(prompt, repoPath, taskName, retryOfSurfaceId) {
        // Packet relaunch must ALWAYS isolate. Without isolate:true, shouldIsolate()
        // falls through to "active worktree count > 0" — when the original lane's
        // worktree was archived before relaunch, the check returns false and codex
        // boots at the main repo root, writing agent changes directly into main.
        // Every packet needs its own worktree, regardless of fleet state.
        //
        // #1292 ROOT — reuse the FAILING session's lane instead of auto-wrapping a
        // fresh sibling. Without existingLaneId the launch creates a brand-new lane
        // (actions.ts auto-wrap), so each retry doubled the lane count. The
        // supervisor's onAgentRetry then rebinds that lane to the new session,
        // matching the existingLaneId "caller attaches the session" convention.
        // Degrades gracefully: no match (lane already archived/gone) → undefined →
        // prior behavior.
        let existingLaneId: string | undefined;
        let existingWorktree: string | undefined;
        if (retryOfSurfaceId) {
          try {
            const { findLaneBySession } = await import('@/lib/lane/registry');
            const lane = findLaneBySession(retryOfSurfaceId);
            existingLaneId = lane?.id ?? undefined;
            existingWorktree = lane?.worktreePath ?? undefined;
          } catch { /* best-effort — fall back to a fresh lane */ }
        }
        // #1293 — RESUME the retry IN THE LANE'S EXISTING WORKTREE when it still
        // exists. The old code always isolated a fresh worktree with the changed
        // "(retry N)" taskName, which orphaned the prior session's committed work:
        // the lane kept its original worktree_path while the new session ran in a
        // disconnected `<task>-retry-N` tree (the silent-exit / retry-worktree
        // disconnect that left the lane stuck `running`/`failed` and never
        // reviewing). Reusing the worktree keeps the work in one place and the
        // lane connected, so the next salvage finalizes it to review. Only
        // isolate a fresh tree when the original is gone (the archived-worktree
        // case the original comment guarded against booting at the main repo).
        const launchBody = (existingWorktree && existsSync(existingWorktree))
          ? { runtime: 'codex', prompt, repoPath: existingWorktree, cwd: existingWorktree, taskName, isolate: false, skipSetup: true, existingLaneId }
          : { runtime: 'codex', prompt, repoPath, cwd: repoPath, taskName, isolate: true, existingLaneId };
        const res = await fetchWithRetry(buildNextUrl('/api/runtime/launch'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(launchBody),
          signal: AbortSignal.timeout(15000),
        });
        const data = await res.json() as { ok?: boolean; surfaceId?: string };
        return data.ok ? (data.surfaceId as string) : null;
      },
      broadcastAgentUpdate(update: AgentUpdateEvent) {
        // #529 — Supervisor/agent lifecycle events go on a dedicated channel,
        // not on the orchestrator channel. The orchestrator chat subscribes
        // to `orchestrator` for its own claude transcript; mixing codex agent
        // state (including watcher-captured transcript snippets) into that
        // channel was bleeding into the UI as mid-stream messages. The new
        // `supervisor` channel is a notification feed — every connected
        // client receives it, and UI surfaces decide where to render.
        broadcast({ channel: 'supervisor', event: 'agent-update', data: update });
      },
      queueOrchestratorEscalation,
      onAgentProgress(surfaceId, lastMessage) {
        // #529 — Progress heartbeats must NOT carry codex transcript prose
        // into the orchestrator chat. The supervisor uses the last-observed
        // assistant sentence only for stuck-detection internally; the outbound
        // event surfaces a neutral "working" marker instead. Any UI that needs
        // more detail can fetch the codex transcript directly.
        const watched = getWatchedAgents().find((agent) => agent.surfaceId === surfaceId);
        const update: AgentUpdateEvent = {
          surfaceId,
          name: watched?.name ?? surfaceId,
          status: watched?.lastStatus ?? 'running',
          detail: 'working',
          repoPath: watched?.repoPath,
        };
        console.log(`[supervisor] Agent ${surfaceId} progress heartbeat (suppressing transcript preview of ${lastMessage.length}ch)`);

        broadcast({ channel: 'supervisor', event: 'agent-update', data: update });
        void handleCodexSelfReviewProgress(surfaceId, lastMessage).catch((error) => {
          console.warn(`[supervisor] Self-review stall probe failed for ${surfaceId}:`, error);
        });
      },
      async onAgentCompletion(surfaceId, outcome) {
        try {
          const { findLaneBySession, setLaneStatus, updateLane } = await import('@/lib/lane/registry');
          const lane = findLaneBySession(surfaceId);
          if (!lane) {
            return;
          }

          const completionCwd = lane.worktreePath ?? lane.repoPath;
          try {
            const { persistRuntimeSessionCost } = await import('@/lib/orchestrator/cost-persistence');
            await persistRuntimeSessionCost({
              sessionKey: surfaceId,
              runtime: lane.runtime,
              repoPath: completionCwd,
            });
          } catch (error) {
            console.error('[cost-persistence] Failed to persist lane session cost:', error);
          }

          if (outcome === 'completed') {
            try {
              // #1103 — commit any staged/dirty work BEFORE judging zero-diff.
              // The supervisor's completion grace keys on transcript growth, not
              // the worktree, so a Codex turn that commits after its last
              // transcript line races this probe and gets a false
              // no_changes_produced. Auto-commit first, then probe, with one
              // bounded settle + re-probe to catch a commit that lands inside
              // the exec/poll window. (Any commit later than this is recovered
              // by the silent-exit detector, not lost.)
              const { autoCommitCompletionWorktree } = await import('@/lib/supervisor/completion-verification');
              try { await autoCommitCompletionWorktree(completionCwd, lane.label); } catch { /* non-fatal — fall through to probe */ }
              let probe = await probeNoChangesProduced(completionCwd, lane.baseBranch);
              if (probe.noChangesProduced) {
                await new Promise((resolve) => setTimeout(resolve, 2000));
                try { await autoCommitCompletionWorktree(completionCwd, lane.label); } catch { /* non-fatal */ }
                probe = await probeNoChangesProduced(completionCwd, lane.baseBranch);
              }
              if (probe.noChangesProduced) {
                const packetId = lane.packetId?.trim();
                const now = new Date().toISOString();
                const { parkHuddleReadyZeroDiffLane } = await import('@/lib/orchestrator/huddle-zero-diff');
                const huddlePark = await parkHuddleReadyZeroDiffLane(lane);
                if (huddlePark.parked) {
                  const label = packetId ? `Packet ${packetId}` : `Lane ${lane.id}`;
                  const detail = `${label} completed its huddle turn with no changes; awaiting orchestrator alignment.`;
                  console.warn(`[supervisor] ${detail}`);
                  return {
                    block: true,
                    detail,
                  };
                }
                const failedLane = setLaneStatus(lane.id, 'failed', 'system', 'zero_diff_failed');

                if (packetId) {
                  try {
                    const { withLockedState } = await import('@/lib/orchestrator/control-plane');
                    await withLockedState((state) => {
                      const packet = state.packets.find((candidate) => candidate.id === packetId);
                      if (!packet) return;
                      packet.status = 'failed';
                      packet.blockedReason = 'no_changes_produced';
                      packet.lastEventAt = now;
                      packet.lastEventLabel = 'zero_diff_failed';
                      if (packet.lane) {
                        packet.lane = {
                          ...packet.lane,
                          laneId: failedLane?.id ?? lane.id,
                          sessionKey: failedLane?.sessionKey ?? lane.sessionKey ?? surfaceId,
                          lastEventAt: now,
                          lastEventLabel: 'zero_diff_failed',
                        };
                      }
                    });
                  } catch (error) {
                    console.error(`[supervisor] Failed to persist no_changes_produced for packet ${packetId}:`, error);
                  }
                }

                const label = packetId ? `Packet ${packetId}` : `Lane ${lane.id}`;
                const detail = `${label} completed with no changes - needs redispatch with clearer guidance.`;
                console.warn(`[supervisor] ${detail}`);
                return {
                  block: true,
                  detail,
                };
              }
            } catch (error) {
              console.warn(`[supervisor] No-changes completion probe failed for ${completionCwd}:`, error);
            }

            const {
              autoCommitCompletionWorktree,
              runCompletionVerification,
            } = await import('@/lib/supervisor/completion-verification');
            const verification = await runCompletionVerification(completionCwd, lane.baseBranch);

            if (!verification.ok) {
              console.warn(`[supervisor] Agent ${surfaceId} failed post-completion ${verification.kind} in ${completionCwd}`);
              let retryPacketId = lane.packetId?.trim() || undefined;
              try {
                const { withLockedState } = await import('@/lib/orchestrator/control-plane');
                const { capturePacketCompletionContext } = await import('@/lib/orchestrator/context-relay');
                const {
                  buildAttemptLearningFromFailure,
                  persistAttemptLearnings,
                  readPacketAttemptLearnings,
                } = await import('@/lib/orchestrator/attempt-log');
                const {
                  markRalphRetryRequeued,
                  resolvePostCompletionPacket,
                } = await import('@/lib/supervisor/post-completion-packet');

                const packetResolution = await resolvePostCompletionPacket(lane.id, lane.packetId);

                if (!packetResolution) {
                  setLaneStatus(lane.id, 'awaiting_input', 'system', 'post_completion_typecheck_packet_not_found');
                  await enqueueVerificationFailureInboxItem({
                    repoPath: lane.repoPath,
                    packetId: lane.packetId?.trim() || undefined,
                    kind: 'packet_missing',
                    laneId: lane.id,
                    worktreePath: completionCwd,
                    sessionKey: surfaceId,
                    baseBranch: lane.baseBranch,
                    packetTitle: lane.label,
                    verificationKind: verification.kind,
                    error: verification.output,
                    note: 'Cannot enter the bounded retry flow because the packet metadata is missing.',
                  });
                  return {
                    block: true,
                    detail: `Post-completion ${verification.kind} failed, but the packet could not be found in mission state. Operator input is required.`,
                  };
                }

                const { packetId, snapshot: packetSnapshot } = packetResolution;
                retryPacketId = packetId;

                const currentAttempt = packetSnapshot.attemptCount;
                const maxAttempts = Math.max(1, packetSnapshot.maxAttempts);
                const attemptNumber = currentAttempt + 1;

                if (currentAttempt < maxAttempts - 1) {
                  const completionContext = await capturePacketCompletionContext(packetId, surfaceId);
                  await persistAttemptLearnings(
                    completionCwd,
                    packetId,
                    attemptNumber,
                    buildAttemptLearningFromFailure(verification.output, completionContext.selfReview),
                  );
                  await autoCommitCompletionWorktree(completionCwd, lane.label);
                  markRalphRetryRequeued(lane.id, packetId);
                  await withLockedState((state) => {
                    const packet = state.packets.find((candidate) => candidate.id === packetId);
                    if (!packet) {
                      throw new Error(`Packet ${packetId} disappeared before bounded retry requeue.`);
                    }

                    const now = new Date().toISOString();
                    packet.attemptCount = attemptNumber;
                    packet.queueState = 'queued';
                    packet.status = 'queued';
                    packet.blockedReason = null;
                    packet.lastEventAt = now;
                    packet.lastEventLabel = 'ralph_retry_requeued';
                    packet.lane = null;
                  });
                  console.warn(`[ralph-loop] Attempt ${attemptNumber}/${maxAttempts} failed for packet ${packetId}, re-queuing with learnings`);
                  void triggerHeadlessSprintTick().catch((error) => {
                    console.error(`[ralph-loop] Failed to trigger headless retry dispatch for packet ${packetId}:`, error);
                  });
                  return;
                }

                const currentLearning = buildAttemptLearningFromFailure(verification.output);
                const priorLearnings = await readPacketAttemptLearnings(packetId, completionCwd);
                const learningSummary = [
                  ...priorLearnings.map((learning) => `- Attempt ${learning.attempt}: ${learning.summary}`),
                  `- Attempt ${attemptNumber}: ${currentLearning.summary}`,
                ].join('\n') || '- No attempt learnings recorded.';

                setLaneStatus(lane.id, 'awaiting_input', 'system', 'ralph_retry_exhausted');
                await enqueueVerificationFailureInboxItem({
                  repoPath: lane.repoPath,
                  packetId,
                  kind: 'bounded_retry_exhausted',
                  laneId: lane.id,
                  worktreePath: completionCwd,
                  sessionKey: surfaceId,
                  baseBranch: lane.baseBranch,
                  packetTitle: packetSnapshot.title,
                  packetReferenceLabel: packetSnapshot.referenceLabel,
                  verificationKind: verification.kind,
                  attempts: `${attemptNumber}/${maxAttempts}`,
                  error: verification.output,
                  note: `Learnings summary:\n${learningSummary}`,
                });
                console.warn(`[ralph-loop] Max attempts (${maxAttempts}) exhausted for packet ${packetId}, escalating to operator`);
                return {
                  block: true,
                  detail: `Post-completion ${verification.kind} failed after ${attemptNumber}/${maxAttempts} attempts. Operator input is required.`,
                };
              } catch (retryError) {
                if (retryPacketId) {
                  updateLane(lane.id, { packetId: retryPacketId }, 'system');
                }
                setLaneStatus(lane.id, 'awaiting_input', 'system', 'ralph_retry_failed');
                await enqueueVerificationFailureInboxItem({
                  repoPath: lane.repoPath,
                  packetId: retryPacketId,
                  kind: 'verification_failed',
                  laneId: lane.id,
                  worktreePath: completionCwd,
                  sessionKey: surfaceId,
                  baseBranch: lane.baseBranch,
                  packetTitle: lane.label,
                  verificationKind: verification.kind,
                  error: verification.output,
                  note: 'The bounded retry handoff failed after the verification error.',
                  retryError: retryError instanceof Error ? retryError.message : String(retryError),
                });
                console.error('[ralph-loop] Failed to process bounded retry handoff:', retryError);
                return {
                  block: true,
                  detail: `Post-completion ${verification.kind} failed and the bounded retry handoff also failed. Operator input is required.`,
                };
              }
            }

            try {
              const committed = await autoCommitCompletionWorktree(completionCwd, lane.label);
              if (committed) {
                console.log(`[supervisor] Agent ${surfaceId} left dirty worktree, auto-committing in ${completionCwd}`);
              }
            } catch (commitErr) {
              console.warn(`[supervisor] Auto-commit check failed for ${completionCwd}:`, commitErr);
            }

            const { transitionPostCompletionLaneToReviewing } = await import('@/lib/supervisor/post-completion-packet');
            const reviewTransition = transitionPostCompletionLaneToReviewing(lane.id, lane.packetId);
            const updated = reviewTransition.lane;
            if (updated) {
              const packetId = reviewTransition.packetId ?? updated.packetId ?? lane.packetId;
              const sessionKey = updated.sessionKey ?? surfaceId;
              if (packetId) {
                try {
                  const { capturePacketCompletionContext } = await import('@/lib/orchestrator/context-relay');
                  await capturePacketCompletionContext(packetId, sessionKey);
                } catch (error) {
                  console.error(`[context-relay] Failed to capture completion context for packet ${packetId}:`, error);
                }
              }
              // #1110 — Both calls are "kick off a downstream job"; their HTTP
              // round-trip is just an enqueue ack. When /api/orchestrator/headless-tick
              // wedges (a stuck singleton tickPromise can hang for 15s+; auto-review
              // is fast at ~4ms), awaiting them propagates a TimeoutError up to the
              // outer catch and the supervisor callback aborts mid-flight — which
              // silently breaks the auto-loop. Detach them: the enqueue still lands,
              // and any slowness in the handler doesn't poison the supervisor.
              void enqueueAutoReview(updated.id).catch((err) => {
                console.warn(`[supervisor] enqueueAutoReview kicked off but errored (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
              });
              void triggerHeadlessSprintTick(packetId ? [packetId] : undefined).catch((err) => {
                console.warn(`[supervisor] triggerHeadlessSprintTick errored (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
              });
              queueReviewContinuation({ ...updated, packetId: packetId ?? updated.packetId });
            }
            console.log(`[supervisor] Agent ${surfaceId} completed, lane ${lane.id} -> reviewing`);
            return;
          }

          setLaneStatus(lane.id, 'awaiting_input', 'system', 'agent_failed');
          console.log(`[supervisor] Agent ${surfaceId} failed, lane ${lane.id} -> awaiting_input`);
        } catch (error) {
          console.error('[supervisor] Completion callback failed:', error);
        }
      },
      onAgentRetry(oldSurfaceId, newSurfaceId) {
        // Update the lane's session binding so the new agent is tracked
        void (async () => {
          try {
            const { findLaneBySession, attachSession } = await import('@/lib/lane/registry');
            const lane = findLaneBySession(oldSurfaceId);
            if (lane) {
              attachSession(lane.id, newSurfaceId, 'system');
              console.log(`[supervisor] Rebound lane ${lane.id} from ${oldSurfaceId.slice(-12)} to ${newSurfaceId.slice(-12)}`);
            }
          } catch (error) {
            console.error('[supervisor] Failed to rebind lane on retry:', error);
          }
        })();
      },
    };
    startSupervisorLoop(supervisorCallbacks);
    // #1292 — self-heal: archive owned-session dirs with no active lane so fleet
    // discovery can't re-spawn phantom lanes from orphans (the multiply). Fire-
    // and-forget; the dominant case is already handled by reset archiving its own
    // dir. Guarded inside each store (skips active/in-flight sessions).
    void import('@/lib/lane/sweep-orphan-sessions')
      .then((m) => m.sweepOrphanedOwnedSessions())
      .catch(() => {});
    stopHeadlessLoop = startHeadlessTickBridge(10_000);
    startWorktreeReaper();
    startLaneZombieReaper();
    // #6 persistent terminals — bounded GC for orphan dash tmux sessions, only
    // when persistence is on (off-path leaves no sessions to reap).
    if (dashPersistentTerminalsEnabled()) startDashSessionGc();
    // Heal-bot AND-gates two toggles (epic #1044 / follow-up #1048):
    //   1. `healBotEnabled` — existing toggle, "do you want auto-fix at all"
    //   2. `inAppOrchestratorEnabled` — added in v0.1.138, "do you have any
    //      LLM sub at all". Heal-bot used to spawn `claude -p` regardless of
    //      the SDK toggle, silently draining Anthropic credits on every
    //      failed lane. Even after the v0.1.138 swap to Codex, we keep the
    //      gate so users with NO subs don't trigger background LLM calls.
    const inAppOrchestratorOn = resolveInAppOrchestratorEnabledSync();
    if (resolveHealBotEnabledSync() && inAppOrchestratorOn) {
      stopHealBotLoop = startHealBot();
    } else if (!inAppOrchestratorOn) {
      console.log('[heal-bot] Start skipped — inAppOrchestratorEnabled is off');
    } else {
      console.log('[heal-bot] Start skipped — disabled via operator defaults');
    }

    if (isSilentExitDetectorEnabled()) {
      stopSilentExitDetectorLoop = startSilentExitDetector();
    } else {
      console.log('[silent-exit] Start skipped — disabled via O8_SILENT_EXIT_DETECTOR_ENABLED');
    }

    void ensureReviewDrainStarted().catch((error) => {
      console.error('[ws-server] Failed to start review queue drain:', error instanceof Error ? error.message : String(error));
    });

    bootCompactorScheduler();
    bootAutomationsScheduler();

    void (async () => {
      try {
        const { startDocWatcher } = await import('@/lib/cortex/indexer/doc-watcher');
        stopDocWatcherLoop = startDocWatcher();
      } catch (error) {
        console.warn(
          `[doc-watcher] Failed to start: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
  });
}

void bootstrapWsServer();

// ── Graceful shutdown ──

function shutdown(signal: string) {
  console.log(`[ws-server] ${signal} received — shutting down gracefully`);

  // Stop agent supervisor and stall detection
  stopSupervisorLoop();
  stopHeadlessLoop?.();
  stopHeadlessLoop = null;
  stopHealBotLoop?.();
  stopHealBotLoop = null;
  stopSilentExitDetectorLoop?.();
  stopSilentExitDetectorLoop = null;
  stopDocWatcherLoop?.();
  stopDocWatcherLoop = null;
  stopRelayConnector();
  stopMachineAttachSupervisor();
  stopWorktreeReaper();
  stopLaneZombieReaper();
  stopDashSessionGc();
  wsWatchdog.stop();
  clearInterval(stallCheckTimer);
  if (runtimeRefreshTimer) clearTimeout(runtimeRefreshTimer);
  if (mobileRefreshTimer) clearTimeout(mobileRefreshTimer);
  for (const timer of sessionHistoryTimers.values()) {
    clearTimeout(timer);
  }
  sessionHistoryTimers.clear();
  if (browserDiscoveryTimer) clearInterval(browserDiscoveryTimer);
  if (attachedBrowserRefreshTimer) clearInterval(attachedBrowserRefreshTimer);

  // Destroy all terminal PTY handles (tmux sessions persist independently)
  for (const [, att] of terminalAttachments) {
    if (att.batchTimer) clearTimeout(att.batchTimer);
    try { att.ptyProcess.kill(); } catch { /* already gone */ }
  }
  terminalAttachments.clear();
  // Tear down the forked terminal-host (child mode); no-op inline.
  try { terminalHost?.dispose(); } catch { /* already gone */ }

  // Send close frame to every client so they reconnect cleanly
  for (const client of clients.values()) {
    try { client.ws.close(1001, 'server shutting down'); } catch { /* already gone */ }
  }
  clients.clear();

  // Close HTTP + WS server, then exit
  wss.close(() => {
    httpServer.close(() => {
      console.log('[ws-server] Clean shutdown complete');
      process.exit(0);
    });
  });

  // Force exit after 3s if something hangs
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
