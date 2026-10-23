import { getSqlite } from '@/lib/db';
import { getLane, setLaneStatus } from '@/lib/lane/registry';
import type { WorktreeLaunchOptions } from './launch';
import type { WorktreeInfo } from './types';

const INVALID_LANE = 'Managed worktree was prepared without an exact unbound pre-launch lane.';
const EVENT_LIMIT = 500;
interface StoredEvent { id: string; sequence: number; verb: string; actor: string; payload_json: string }

/** Capture this attempt before I/O; validate again while creation can still roll back. */
export function captureLaunchLaneValidation(opts: WorktreeLaunchOptions): ((worktree: WorktreeInfo) => void) | undefined {
  if (!opts.isolate || !opts.laneId || !opts.packetId) return undefined;
  const laneId = opts.laneId;
  const exactLane = (worktreePath?: string) => {
    const lane = getLane(laneId);
    if (!lane || lane.packetId !== opts.packetId || lane.runtime !== opts.agentType
      || lane.repoPath !== opts.repoRoot || lane.branch !== opts.branchName
      || lane.sessionKey !== null
      || (lane.worktreePath !== null && lane.worktreePath !== worktreePath)) {
      throw new Error(INVALID_LANE);
    }
    return lane;
  };
  if (exactLane().status !== 'launching') throw new Error(INVALID_LANE);
  const sqlite = getSqlite();
  // SQLite insertion order disambiguates events written in the same millisecond.
  const anchor = sqlite.prepare('SELECT rowid AS sequence, id FROM lane_events WHERE lane_id = ? ORDER BY rowid DESC LIMIT 1')
    .get(laneId) as Pick<StoredEvent, 'sequence' | 'id'> | undefined;
  if (!anchor) throw new Error(INVALID_LANE);

  return (worktree) => sqlite.transaction(() => {
    const lane = exactLane(worktree.path);
    const anchorPresent = sqlite.prepare('SELECT id FROM lane_events WHERE lane_id = ? AND rowid = ?').pluck().get(laneId, anchor.sequence);
    const rows = sqlite.prepare('SELECT id, rowid AS sequence, verb, actor, payload_json FROM lane_events WHERE lane_id = ? AND rowid > ? ORDER BY rowid LIMIT ?')
      .all(laneId, anchor.sequence, EVENT_LIMIT + 1) as StoredEvent[];
    if (anchorPresent !== anchor.id || rows.length > EVENT_LIMIT) throw new Error(INVALID_LANE);
    const suffix = rows.map((event) => ({ ...event, payload: JSON.parse(event.payload_json) as Record<string, unknown> }));
    // Dependency, manifest and preparation-timing receipts do not grant or revoke launch
    // authority. Every other intervening decision, binding, reservation or new
    // attempt invalidates it.
    const decisions = suffix.filter((event) => !(event.actor === 'system'
      && (event.verb === 'dependency_materialized' || event.verb === 'worktree_preparation_timing'
        || event.verb === 'workspace_manifest_applied' || event.verb === 'workspace_manifest_failed'
        || event.verb === 'workspace_manifest_skipped')));
    if (lane.status === 'launching' && decisions.length === 0) return;
    const [wedge, transition] = decisions;
    if (lane.status !== 'awaiting_orchestrator' || lane.lastEventLabel !== 'launch_stalled'
      || decisions.length !== 2 || wedge?.actor !== 'system' || wedge.verb !== 'wedge_timeout'
      || wedge.payload.from !== 'launching' || wedge.payload.to !== 'awaiting_orchestrator'
      || wedge.payload.blockedReason !== 'launch_stalled'
      || transition?.actor !== 'system' || transition.verb !== 'status_change'
      || transition.payload.status !== 'awaiting_orchestrator' || transition.payload.eventLabel !== 'launch_stalled') {
      throw new Error(INVALID_LANE);
    }
    // The watchdog observed this same preparation, not a lost worker. Continue
    // only that untouched attempt; human decisions and newer launches stay final.
    const resumed = setLaneStatus(laneId, 'launching', 'system', 'worktree_preparation_finished');
    if (resumed?.status !== 'launching') throw new Error(INVALID_LANE);
  })();
}
