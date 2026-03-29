/**
 * Agent Supervisor — zero-cost rules engine that monitors launched Codex agents.
 *
 * Pure Node.js. No LLM tokens. Polls fleet inventory on a configurable interval,
 * detects status changes, and auto-handles common cases (retry, steer, relaunch).
 * Only escalates to the orchestrator (Opus) when a human-level decision is needed.
 *
 * The ws-server injects callbacks so this module has no HTTP/WS/LLM dependencies.
 */

// ── Types ──

export interface WatchedAgent {
  surfaceId: string;
  repoPath: string;
  name: string;
  prompt: string;
  registeredAt: number;
  lastStatus: string;
  lastTranscriptLength: number;
  lastActivityAt: number;
  retryCount: number;
  steerCount: number;
  completionReported: boolean;
  /** Set when all-done escalation has been sent for this agent's batch */
  batchReported: boolean;
  /** Timestamp when a tentative 'finished' status was first observed (grace period) */
  tentativeFinishedSince: number | null;
  /** Transcript length snapshot taken when tentative finish started */
  tentativeTranscriptLength: number;
}

export interface AgentStatusEntry {
  sessionKey: string;
  status: string;
  name?: string;
  workspace?: string;
  currentTask?: string;
}

export interface TranscriptEntry {
  id: string;
  role: string;
  text: string;
  timestamp?: number;
  timestampLabel?: string;
  toolName?: string;
}

export interface AgentUpdateEvent {
  surfaceId: string;
  name: string;
  status: string;
  detail?: string;
  duration?: number;
  repoPath?: string;
}

export interface SupervisorCallbacks {
  fetchFleetStatus(): Promise<AgentStatusEntry[]>;
  fetchTranscript(sessionKey: string, limit: number): Promise<TranscriptEntry[]>;
  steerAgent(surfaceId: string, message: string): Promise<void>;
  interruptAgent(surfaceId: string): Promise<void>;
  relaunchAgent(prompt: string, repoPath: string, taskName: string): Promise<string | null>;
  broadcastAgentUpdate(update: AgentUpdateEvent): void;
  queueOrchestratorEscalation(repoPath: string, message: string): void;
}

// ── Constants ──

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const STUCK_THRESHOLD_MS = 2 * 60 * 1000;       // 2 min no transcript change
const MAX_RETRIES = 1;                            // Auto-retry once on failure
const MAX_STEERS = 2;                             // Auto-steer twice before escalate
const COMPLETION_CLEANUP_MS = 60_000;             // Remove from watch 60s after done
const COMPLETION_CONFIRM_MS = 15_000;             // 15s grace before confirming completion

// ── State ──

const watchedAgents = new Map<string, WatchedAgent>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let callbacks: SupervisorCallbacks | null = null;
let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;

// ── Public API ──

export function registerWatchedAgent(
  surfaceId: string,
  repoPath: string,
  name: string,
  prompt: string,
): void {
  watchedAgents.set(surfaceId, {
    surfaceId,
    repoPath,
    name,
    prompt,
    registeredAt: Date.now(),
    lastStatus: 'running',
    lastTranscriptLength: 0,
    lastActivityAt: Date.now(),
    retryCount: 0,
    steerCount: 0,
    completionReported: false,
    batchReported: false,
    tentativeFinishedSince: null,
    tentativeTranscriptLength: 0,
  });
  console.log(`[supervisor] Watching agent "${name}" (${surfaceId})`);

  callbacks?.broadcastAgentUpdate({
    surfaceId,
    name,
    status: 'launched',
    detail: `Agent "${name}" launched`,
    repoPath,
  });
}

export function unregisterWatchedAgent(surfaceId: string): void {
  const agent = watchedAgents.get(surfaceId);
  if (agent) {
    console.log(`[supervisor] Unwatching agent "${agent.name}" (${surfaceId})`);
    watchedAgents.delete(surfaceId);
  }
}

export function getWatchedAgents(repoPath?: string): WatchedAgent[] {
  const all = [...watchedAgents.values()];
  return repoPath ? all.filter((a) => a.repoPath === repoPath) : all;
}

export function getWatchedAgentCount(): number {
  return watchedAgents.size;
}

export function setSupervisorPollInterval(ms: number): void {
  pollIntervalMs = Math.max(1000, Math.min(30_000, ms));
  if (pollTimer && callbacks) {
    stopSupervisorLoop();
    startSupervisorLoop(callbacks);
  }
  console.log(`[supervisor] Poll interval set to ${pollIntervalMs}ms`);
}

export function startSupervisorLoop(cbs: SupervisorCallbacks): void {
  callbacks = cbs;
  if (pollTimer) return;

  pollTimer = setInterval(() => {
    if (watchedAgents.size === 0) return;
    void supervisorTick().catch((err) => {
      console.error('[supervisor] Poll error:', err);
    });
  }, pollIntervalMs);

  console.log(`[supervisor] Started (${pollIntervalMs}ms interval)`);
}

export function stopSupervisorLoop(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  console.log('[supervisor] Stopped');
}

export function cleanupWatchedAgentsForRepo(repoPath: string): void {
  for (const [id, agent] of watchedAgents) {
    if (agent.repoPath === repoPath) {
      watchedAgents.delete(id);
    }
  }
}

// ── Core Poll Tick ──

async function supervisorTick(): Promise<void> {
  if (!callbacks || watchedAgents.size === 0) return;

  let fleet: AgentStatusEntry[];
  try {
    fleet = await callbacks.fetchFleetStatus();
  } catch {
    return; // Fleet fetch failed — skip this tick
  }

  const fleetMap = new Map(fleet.map((a) => [a.sessionKey, a]));
  const now = Date.now();

  for (const [surfaceId, watched] of watchedAgents) {
    const agent = fleetMap.get(surfaceId);
    const currentStatus = resolveStatus(agent, watched, now);

    // ── Completion grace period ──
    // Codex agents can briefly report idle/reviewing between tool calls.
    // Require the 'finished' signal to persist for COMPLETION_CONFIRM_MS
    // AND transcript must stop growing before we confirm completion.
    if (currentStatus === 'finished' && !watched.completionReported) {
      if (!watched.tentativeFinishedSince) {
        // First time seeing 'finished' — start grace period
        watched.tentativeFinishedSince = now;
        try {
          const entries = await callbacks.fetchTranscript(surfaceId, 5);
          watched.tentativeTranscriptLength = entries.reduce(
            (sum, e) => sum + (e.text?.length ?? 0), 0,
          );
        } catch {
          watched.tentativeTranscriptLength = watched.lastTranscriptLength;
        }
        console.log(`[supervisor] "${watched.name}" tentatively finished — confirming over ${COMPLETION_CONFIRM_MS / 1000}s`);
        continue;
      }

      const elapsed = now - watched.tentativeFinishedSince;
      if (elapsed < COMPLETION_CONFIRM_MS) {
        continue; // Still in grace period — wait
      }

      // Grace period elapsed — verify transcript hasn't grown
      try {
        const entries = await callbacks.fetchTranscript(surfaceId, 5);
        const currentLength = entries.reduce(
          (sum, e) => sum + (e.text?.length ?? 0), 0,
        );
        if (currentLength > watched.tentativeTranscriptLength) {
          // Transcript grew — agent is still working, reset
          watched.tentativeFinishedSince = null;
          watched.lastTranscriptLength = currentLength;
          watched.lastActivityAt = now;
          console.log(`[supervisor] "${watched.name}" transcript grew during grace — still active`);
          continue;
        }
      } catch { /* proceed with confirmation if fetch fails */ }

      // Confirmed finished — clear tentative and fall through
      watched.tentativeFinishedSince = null;
      console.log(`[supervisor] "${watched.name}" completion confirmed after grace period`);
    } else if (currentStatus !== 'finished' && watched.tentativeFinishedSince) {
      // Status reverted to non-terminal — cancel tentative finish
      console.log(`[supervisor] "${watched.name}" back to "${currentStatus}" — canceling tentative finish`);
      watched.tentativeFinishedSince = null;
    }

    // Status changed?
    if (currentStatus !== watched.lastStatus) {
      const prevStatus = watched.lastStatus;
      watched.lastStatus = currentStatus;
      console.log(`[supervisor] "${watched.name}" ${prevStatus} → ${currentStatus}`);

      await handleStatusChange(watched, currentStatus, now);
    }

    // Stuck detection (for running or waiting agents)
    if (currentStatus === 'running' || currentStatus === 'waiting') {
      await checkStuck(watched, now);
    }
  }

  // Check if all watched agents for any repo are done
  checkAllDone();
}

// ── Status Resolution ──

function resolveStatus(
  agent: AgentStatusEntry | undefined,
  watched: WatchedAgent,
  now: number,
): string {
  if (!agent) {
    // Not in fleet — if recently registered, may not have appeared yet
    const age = now - watched.registeredAt;
    if (age < 30_000) return 'launching';
    // Old and missing — treat as finished or failed
    return 'finished';
  }

  const s = agent.status;
  if (s === 'running') return 'running';
  if (s === 'failed' || s === 'blocked') return 'failed';
  if (s === 'reviewing') return 'finished';
  if (s === 'waiting') return 'waiting';
  if (s === 'idle') return 'finished';
  return s;
}

function isTerminal(status: string): boolean {
  return status === 'finished' || status === 'failed' || status === 'interrupted';
}

// ── Event Handlers ──

async function handleStatusChange(
  watched: WatchedAgent,
  status: string,
  now: number,
): Promise<void> {
  if (!callbacks) return;

  const duration = Math.round((now - watched.registeredAt) / 1000);

  if (status === 'finished' && !watched.completionReported) {
    watched.completionReported = true;
    callbacks.broadcastAgentUpdate({
      surfaceId: watched.surfaceId,
      name: watched.name,
      status: 'completed',
      duration,
      detail: `Agent "${watched.name}" completed (${formatDuration(duration)})`,
    });

    // Schedule cleanup
    setTimeout(() => unregisterWatchedAgent(watched.surfaceId), COMPLETION_CLEANUP_MS);
  }

  if (status === 'failed') {
    if (watched.retryCount < MAX_RETRIES) {
      // Auto-retry
      watched.retryCount += 1;
      console.log(`[supervisor] Auto-retrying "${watched.name}" (attempt ${watched.retryCount})`);

      callbacks.broadcastAgentUpdate({
        surfaceId: watched.surfaceId,
        name: watched.name,
        status: 'retrying',
        detail: `Agent "${watched.name}" failed — auto-retrying (attempt ${watched.retryCount})`,
      });

      try {
        const newSurfaceId = await callbacks.relaunchAgent(
          watched.prompt,
          watched.repoPath,
          `${watched.name} (retry ${watched.retryCount})`,
        );
        if (newSurfaceId) {
          // Transfer watch to new agent
          watchedAgents.delete(watched.surfaceId);
          registerWatchedAgent(newSurfaceId, watched.repoPath, watched.name, watched.prompt);
          const newWatched = watchedAgents.get(newSurfaceId);
          if (newWatched) {
            newWatched.retryCount = watched.retryCount;
            newWatched.steerCount = watched.steerCount;
          }
        }
      } catch (err) {
        console.error(`[supervisor] Retry failed for "${watched.name}":`, err);
      }
    } else {
      // Exhausted retries — escalate
      watched.completionReported = true;
      callbacks.broadcastAgentUpdate({
        surfaceId: watched.surfaceId,
        name: watched.name,
        status: 'failed',
        duration,
        detail: `Agent "${watched.name}" failed after ${watched.retryCount + 1} attempts — escalating`,
      });

      // Read transcript for the escalation
      let transcriptSummary = '';
      try {
        const entries = await callbacks.fetchTranscript(watched.surfaceId, 10);
        transcriptSummary = entries
          .map((e) => `[${e.timestampLabel ?? '?'}] ${e.role}: ${truncate(e.text, 200)}`)
          .join('\n');
      } catch { /* best effort */ }

      callbacks.queueOrchestratorEscalation(
        watched.repoPath,
        [
          `[SUPERVISOR] Agent "${watched.name}" (${watched.surfaceId}) — FAILED after ${watched.retryCount + 1} attempts (${formatDuration(duration)})`,
          '',
          transcriptSummary ? `Last transcript:\n${transcriptSummary}` : 'No transcript available.',
          '',
          'Auto-retry exhausted. Diagnose the failure and decide: relaunch with a different approach, or report to the user.',
        ].join('\n'),
      );

      setTimeout(() => unregisterWatchedAgent(watched.surfaceId), COMPLETION_CLEANUP_MS);
    }
  }

  if (status === 'interrupted') {
    watched.completionReported = true;
    callbacks.broadcastAgentUpdate({
      surfaceId: watched.surfaceId,
      name: watched.name,
      status: 'interrupted',
      duration,
      detail: `Agent "${watched.name}" was interrupted`,
    });
    setTimeout(() => unregisterWatchedAgent(watched.surfaceId), COMPLETION_CLEANUP_MS);
  }
}

// ── Stuck Detection ──

async function checkStuck(watched: WatchedAgent, now: number): Promise<void> {
  if (!callbacks) return;

  // Grace period after registration
  if (now - watched.registeredAt < 30_000) return;

  // Check transcript for new content
  try {
    const entries = await callbacks.fetchTranscript(watched.surfaceId, 5);
    const totalLength = entries.reduce((sum, e) => sum + (e.text?.length ?? 0), 0);

    if (totalLength !== watched.lastTranscriptLength) {
      watched.lastTranscriptLength = totalLength;
      watched.lastActivityAt = now;
      return; // Activity detected — not stuck
    }
  } catch {
    return; // Transcript fetch failed — skip
  }

  const staleDuration = now - watched.lastActivityAt;
  if (staleDuration < STUCK_THRESHOLD_MS) return;

  // Agent is stuck
  if (watched.steerCount < MAX_STEERS) {
    watched.steerCount += 1;
    watched.lastActivityAt = now; // Reset timer after steer
    console.log(`[supervisor] Auto-steering stuck agent "${watched.name}" (steer ${watched.steerCount})`);

    callbacks.broadcastAgentUpdate({
      surfaceId: watched.surfaceId,
      name: watched.name,
      status: 'stuck',
      detail: `Agent "${watched.name}" appears stuck — auto-steering (attempt ${watched.steerCount})`,
    });

    const steerMessage = watched.steerCount === 1
      ? 'You appear to be stuck. Summarize what you have done so far and what is blocking you. Then try a different approach.'
      : 'You are still stuck. Stop your current approach. Try the simplest possible solution to complete the task.';

    try {
      await callbacks.steerAgent(watched.surfaceId, steerMessage);
    } catch (err) {
      console.error(`[supervisor] Steer failed for "${watched.name}":`, err);
    }
  } else {
    // Exhausted steers — interrupt + relaunch or escalate
    watched.completionReported = true;
    console.log(`[supervisor] Agent "${watched.name}" stuck after ${watched.steerCount} steers — escalating`);

    callbacks.broadcastAgentUpdate({
      surfaceId: watched.surfaceId,
      name: watched.name,
      status: 'stuck',
      detail: `Agent "${watched.name}" stuck after ${watched.steerCount} steers — escalating`,
    });

    // Interrupt the stuck agent
    try {
      await callbacks.interruptAgent(watched.surfaceId);
    } catch { /* best effort */ }

    const duration = Math.round((now - watched.registeredAt) / 1000);
    callbacks.queueOrchestratorEscalation(
      watched.repoPath,
      [
        `[SUPERVISOR] Agent "${watched.name}" (${watched.surfaceId}) — STUCK for ${formatDuration(duration)}`,
        `Auto-steered ${watched.steerCount} times without progress. Agent has been interrupted.`,
        '',
        'Decide: relaunch with a simpler/different prompt, or report to the user.',
      ].join('\n'),
    );

    setTimeout(() => unregisterWatchedAgent(watched.surfaceId), COMPLETION_CLEANUP_MS);
  }
}

// ── All-Done Check ──

function checkAllDone(): void {
  if (!callbacks) return;

  // Group by repoPath
  const byRepo = new Map<string, WatchedAgent[]>();
  for (const agent of watchedAgents.values()) {
    const list = byRepo.get(agent.repoPath) ?? [];
    list.push(agent);
    byRepo.set(agent.repoPath, list);
  }

  for (const [repoPath, agents] of byRepo) {
    // All agents done and not yet batch-reported?
    const allDone = agents.every((a) => a.completionReported);
    const anyUnreported = agents.some((a) => !a.batchReported);
    if (!allDone || !anyUnreported) continue;
    if (agents.length === 0) continue;

    // Mark all as batch-reported
    for (const a of agents) a.batchReported = true;

    // Build summary
    const lines = agents.map((a) => {
      const duration = Math.round((Date.now() - a.registeredAt) / 1000);
      const label = a.lastStatus === 'failed' || a.lastStatus === 'interrupted' ? 'FAILED' : 'COMPLETED';
      return `- "${a.name}" (${a.surfaceId}): ${label} (${formatDuration(duration)})`;
    });

    const allSucceeded = agents.every((a) => a.lastStatus === 'finished');
    const suffix = allSucceeded
      ? 'All agents completed successfully. Summarize the results and report to the user.'
      : 'Some agents failed. Review the results and report to the user.';

    callbacks.queueOrchestratorEscalation(
      repoPath,
      [
        `[SUPERVISOR] All ${agents.length} agents finished.`,
        ...lines,
        '',
        suffix,
      ].join('\n'),
    );
  }
}

// ── Helpers ──

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function truncate(text: string, max: number): string {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '...' : text;
}
