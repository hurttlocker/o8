import type { LaneLifecycleEventPayload } from '@/lib/realtime/types';
import type { OrchestratorPacketStatus } from '@/lib/orchestrator/types';

export interface NormalizeRuntimeStatusOptions {
  waitingAsRunning?: boolean;
  fallbackStatus?: OrchestratorPacketStatus | null;
}

// `isTerminalRuntimeStatus` (plan 010) was removed here (#1467). The audit
// found every candidate consumer intentionally classifies on a DIFFERENT axis
// (dispatch policy, release evidence, lane status, packet status) — wiring the
// runtime-label classifier into any of them would have silently changed
// behavior. The trap it guarded ("watchers sleep through parked packets") is
// closed at the packet axis instead: `blocked` is in the watchers' attention
// set (PACKET_ATTENTION_STATUSES in mcp/operator-handlers/mission.ts + the CLI
// mirror in cli/src/commands/mission.ts).

// ── Lane lifecycle ring buffer ──
//
// #619 — An MCP-agent driver needs to long-poll for lane-lifecycle events
// without racing the WebSocket broadcaster. We record every event published
// by `publishLaneLifecycleEvent` (see `src/lib/lane/lifecycle.ts`) into a
// small in-process ring buffer keyed by a monotonic `seq`. The HTTP route
// `/api/orchestrator/lane-events` reads through `getLaneEventsSince` which
// either returns immediately (when events newer than the caller's cursor
// exist) or registers a one-shot listener and awaits up to `timeoutMs`.

export interface LaneLifecycleEventRecord extends LaneLifecycleEventPayload {
  seq: number;
}

const LANE_EVENT_BUFFER_MAX = 500;
const LANE_EVENT_WAIT_MAX_MS = 25_000;

const laneEventBuffer: LaneLifecycleEventRecord[] = [];
const laneEventListeners = new Set<() => void>();
let laneEventSeq = 0;

function filterLaneEvents(
  events: LaneLifecycleEventRecord[],
  since: number,
  laneFilter?: ReadonlySet<string>,
): LaneLifecycleEventRecord[] {
  return events.filter((event) => {
    if (event.seq <= since) return false;
    if (laneFilter && !laneFilter.has(event.laneId)) return false;
    return true;
  });
}

/**
 * Append a lane-lifecycle event to the ring buffer and notify any waiting
 * long-pollers. Oldest entries are dropped once the buffer exceeds
 * LANE_EVENT_BUFFER_MAX. Safe to call from any server-side surface.
 */
export function recordLaneEvent(event: LaneLifecycleEventPayload): LaneLifecycleEventRecord {
  laneEventSeq += 1;
  const record: LaneLifecycleEventRecord = { ...event, seq: laneEventSeq };
  laneEventBuffer.push(record);
  while (laneEventBuffer.length > LANE_EVENT_BUFFER_MAX) {
    laneEventBuffer.shift();
  }

  if (laneEventListeners.size > 0) {
    const listeners = Array.from(laneEventListeners);
    laneEventListeners.clear();
    for (const listener of listeners) {
      try {
        listener();
      } catch (err) {
        console.error(`[runtime-status] lane-event listener threw: ${err}`);
      }
    }
  }

  return record;
}

/**
 * Return lane events with `seq > since`. If the buffer already has matching
 * events, resolves immediately. Otherwise registers a one-time listener and
 * resolves with `[]` after `timeoutMs` (clamped to [0, 25000]).
 */
export async function getLaneEventsSince(
  since: number,
  timeoutMs: number,
  laneFilter?: ReadonlySet<string>,
): Promise<{ events: LaneLifecycleEventRecord[]; nextSince: number }> {
  const clampedSince = Number.isFinite(since) && since >= 0 ? Math.floor(since) : 0;
  const clampedTimeout = Math.max(0, Math.min(LANE_EVENT_WAIT_MAX_MS, Number.isFinite(timeoutMs) ? timeoutMs : 0));

  const immediate = filterLaneEvents(laneEventBuffer, clampedSince, laneFilter);
  if (immediate.length > 0 || clampedTimeout === 0) {
    return {
      events: immediate,
      nextSince: immediate.length > 0 ? immediate[immediate.length - 1].seq : clampedSince,
    };
  }

  return new Promise((resolve) => {
    let settled = false;
    const listener = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      laneEventListeners.delete(listener);
      const pending = filterLaneEvents(laneEventBuffer, clampedSince, laneFilter);
      resolve({
        events: pending,
        nextSince: pending.length > 0 ? pending[pending.length - 1].seq : clampedSince,
      });
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      laneEventListeners.delete(listener);
      resolve({ events: [], nextSince: clampedSince });
    }, clampedTimeout);
    laneEventListeners.add(listener);
  });
}

export function normalizeRuntimeStatusToOrchestratorStatus(
  status?: string | null,
  options: NormalizeRuntimeStatusOptions = {},
): OrchestratorPacketStatus | null {
  const fallbackStatus = options.fallbackStatus === undefined ? 'idle' : options.fallbackStatus;
  const normalized = status?.trim().toLowerCase() ?? '';

  if (normalized === 'running' || normalized === 'working') {
    return 'running';
  }
  if (normalized === 'waiting') {
    return options.waitingAsRunning ? 'running' : fallbackStatus;
  }
  if (normalized === 'reviewing') {
    return 'awaiting_review';
  }
  if (normalized === 'blocked' || normalized === 'awaiting_orchestrator' || normalized === 'awaiting_human' || normalized === 'error') {
    return 'blocked';
  }
  if (normalized === 'failed') {
    return 'failed';
  }
  if (normalized === 'queued') {
    return 'queued';
  }
  if (normalized === 'launching') {
    return 'launching';
  }
  if (normalized === 'recovering') {
    return 'recovering';
  }
  if (normalized === 'released') {
    return 'released';
  }
  if (normalized === 'archived') {
    return 'archived';
  }
  if (normalized === 'idle') {
    return 'idle';
  }

  return fallbackStatus;
}
