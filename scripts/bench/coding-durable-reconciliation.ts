import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import type { LaneStatus } from '../../src/lib/lane/types';
import {
  TurnStatus,
  classifyArmStatus,
  type ArmClassification,
  type ArmErrorReceipt,
} from './coding-arm-outcome';

const MAX_DIFF_BYTES = 32 * 1024 * 1024;

export type DurableStateView = 'notLoaded' | 'summary' | 'full';
export type DurableCompletionBoundary = 'worker-turn' | 'governed-review';

interface DurableLaneRow {
  id: string;
  packet_id: string;
  status: string;
  outcome: string | null;
  branch: string;
  worktree_path: string | null;
  session_key: string | null;
}

interface DurableLaneEventRow {
  verb: string;
  payload_json: string;
  timestamp: string;
}

export interface DurablePacketState {
  view: DurableStateView;
  completionBoundary: DurableCompletionBoundary;
  packetId: string;
  laneId: string | null;
  laneStatus: string | null;
  laneOutcome: string | null;
  branch: string | null;
  sessionKey: string | null;
  worktreePath: string | null;
  worktreeExists: boolean;
  headSha: string | null;
  diffBase: string | null;
  recoveredDiff: string;
  terminalStatus: TurnStatus.Completed | TurnStatus.Interrupted | TurnStatus.Failed | null;
  terminalEvent: string | null;
  eventCount: number;
  error: string | null;
}

export interface DurableReconciliationReceipt extends Omit<DurablePacketState, 'recoveredDiff'> {
  streamStatus: TurnStatus | null;
  durableStatus: TurnStatus.Completed | TurnStatus.Interrupted | TurnStatus.Failed | null;
  disagreement: boolean;
}

function dataDir(override?: string): string {
  return override
    ?? process.env.CORTEX_IDE_DATA_DIR
    ?? path.join(os.homedir(), '.o8');
}

function isLaneStatus(value: string): value is LaneStatus {
  return value === 'idle'
    || value === 'launching'
    || value === 'running'
    || value === 'paused'
    || value === 'awaiting_input'
    || value === 'awaiting_orchestrator'
    || value === 'awaiting_human'
    || value === 'recovering'
    || value === 'reviewing'
    || value === 'merging'
    || value === 'failed'
    || value === 'completed'
    || value === 'archived';
}

function turnStatusFromLane(
  status: LaneStatus,
  outcome: string | null,
  completionBoundary: DurableCompletionBoundary,
): DurablePacketState['terminalStatus'] {
  const completed = completionBoundary === 'worker-turn' ? TurnStatus.Completed : null;
  switch (status) {
    case 'reviewing':
      return completed;
    case 'completed':
      return completed;
    case 'failed':
      return TurnStatus.Failed;
    case 'paused':
      return TurnStatus.Interrupted;
    case 'archived':
      if (outcome === 'merged' || outcome === 'no_changes' || outcome === 'pr_opened') {
        return completed;
      }
      if (outcome === 'closed_unmerged') return TurnStatus.Failed;
      if (outcome === 'discarded' || outcome === 'archived_recoverable') return TurnStatus.Interrupted;
      return null;
    case 'idle':
    case 'launching':
    case 'running':
    case 'awaiting_input':
    case 'awaiting_orchestrator':
    case 'awaiting_human':
    case 'recovering':
    case 'merging':
      return null;
  }
  const exhaustive: never = status;
  throw new Error(`unclassified lane status: ${String(exhaustive)}`);
}

function eventTerminalStatus(
  event: DurableLaneEventRow,
  completionBoundary: DurableCompletionBoundary,
): DurablePacketState['terminalStatus'] {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(event.payload_json) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (event.verb === 'runtime_process_exit') {
    if (completionBoundary === 'governed-review') return null;
    if (payload.classification === 'signal-kill') return TurnStatus.Interrupted;
    if (payload.completedTurn === true) {
      if (payload.exitCode === 0) return TurnStatus.Completed;
      if (typeof payload.exitCode === 'number') return TurnStatus.Failed;
    }
    return null;
  }
  if (event.verb !== 'status_change' || typeof payload.status !== 'string') return null;
  return isLaneStatus(payload.status)
    ? turnStatusFromLane(payload.status, null, completionBoundary)
    : null;
}

function readWorktree(worktreePath: string | null, expectedBase: string): {
  exists: boolean;
  headSha: string | null;
  diffBase: string | null;
  diff: string;
  error: string | null;
} {
  if (!worktreePath || !fs.existsSync(worktreePath)) {
    return { exists: false, headSha: null, diffBase: null, diff: '', error: 'packet worktree was not found' };
  }
  try {
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: worktreePath,
      encoding: 'utf8',
    }).trim();
    const diff = execFileSync('git', ['diff', '--binary', expectedBase, 'HEAD'], {
      cwd: worktreePath,
      encoding: 'utf8',
      maxBuffer: MAX_DIFF_BYTES,
    });
    return { exists: true, headSha, diffBase: expectedBase, diff, error: null };
  } catch (error) {
    return {
      exists: true,
      headSha: null,
      diffBase: null,
      diff: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function readDurablePacketState(input: {
  packetId: string;
  expectedBase: string;
  dataDir?: string;
  completionBoundary?: DurableCompletionBoundary;
}): DurablePacketState {
  const completionBoundary = input.completionBoundary ?? 'worker-turn';
  const empty: DurablePacketState = {
    view: 'notLoaded',
    completionBoundary,
    packetId: input.packetId,
    laneId: null,
    laneStatus: null,
    laneOutcome: null,
    branch: null,
    sessionKey: null,
    worktreePath: null,
    worktreeExists: false,
    headSha: null,
    diffBase: null,
    recoveredDiff: '',
    terminalStatus: null,
    terminalEvent: null,
    eventCount: 0,
    error: null,
  };
  let database: Database.Database | null = null;
  try {
    database = new Database(path.join(dataDir(input.dataDir), 'cortex-ide.db'), {
      readonly: true,
      fileMustExist: true,
    });
    const lane = database.prepare(`
      SELECT id, packet_id, status, outcome, branch, worktree_path, session_key
      FROM lanes
      WHERE packet_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(input.packetId) as DurableLaneRow | undefined;
    if (!lane) return { ...empty, view: 'summary', error: 'packet lane was not found' };
    const events = database.prepare(`
      SELECT verb, payload_json, timestamp
      FROM lane_events
      WHERE lane_id = ?
      ORDER BY timestamp ASC, rowid ASC
    `).all(lane.id) as DurableLaneEventRow[];
    let terminalStatus: DurablePacketState['terminalStatus'] = null;
    let terminalEvent: string | null = null;
    for (const event of events) {
      const status = eventTerminalStatus(event, completionBoundary);
      if (status !== null) {
        terminalStatus = status;
        terminalEvent = `${event.verb}@${event.timestamp}`;
      }
    }
    if (isLaneStatus(lane.status)) {
      const laneTerminal = turnStatusFromLane(lane.status, lane.outcome, completionBoundary);
      if (laneTerminal !== null) {
        terminalStatus = laneTerminal;
        terminalEvent = `lanes.status=${lane.status}`;
      }
    }
    const worktree = readWorktree(lane.worktree_path, input.expectedBase);
    return {
      view: worktree.exists && worktree.error === null ? 'full' : 'summary',
      completionBoundary,
      packetId: input.packetId,
      laneId: lane.id,
      laneStatus: lane.status,
      laneOutcome: lane.outcome,
      branch: lane.branch,
      sessionKey: lane.session_key,
      worktreePath: lane.worktree_path,
      worktreeExists: worktree.exists,
      headSha: worktree.headSha,
      diffBase: worktree.diffBase,
      recoveredDiff: worktree.diff,
      terminalStatus,
      terminalEvent,
      eventCount: events.length,
      error: worktree.error,
    };
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : String(error) };
  } finally {
    database?.close();
  }
}

function terminalOrNull(status: TurnStatus | null): DurablePacketState['terminalStatus'] {
  if (status === null) return null;
  switch (status) {
    case TurnStatus.Completed:
    case TurnStatus.Failed:
    case TurnStatus.Interrupted:
      return status;
    case TurnStatus.InProgress:
      return null;
  }
  const exhaustive: never = status;
  throw new Error(`unclassified turn status: ${String(exhaustive)}`);
}

export function reconcileArmWithDurableState(input: {
  streamStatus: TurnStatus | null;
  streamErrors?: ArmErrorReceipt[];
  durable: DurablePacketState;
  governedReview?: { approved: boolean; approvalId: string | null } | null;
  preserveObservedFailure?: boolean;
}): ArmClassification & { durableReconciliation: DurableReconciliationReceipt } {
  const governedBoundary = input.durable.completionBoundary === 'governed-review';
  const governedReviewCompleted = governedBoundary
    && input.governedReview?.approved === true;
  const observedStreamTerminal = terminalOrNull(input.streamStatus);
  const eligibleStreamStatus = governedBoundary
    && observedStreamTerminal === TurnStatus.Completed
    && !governedReviewCompleted
    ? null
    : input.streamStatus;
  const streamTerminal = terminalOrNull(eligibleStreamStatus);
  const durableCompletionRejected = governedBoundary
    && input.durable.terminalStatus === TurnStatus.Completed
    && !governedReviewCompleted;
  const durableTerminal = governedReviewCompleted
    ? TurnStatus.Completed
    : durableCompletionRejected
      ? null
      : input.durable.terminalStatus;
  const durableTerminalEvent = governedReviewCompleted
    ? `durable_review=${input.governedReview?.approvalId ?? 'approved-current-head'}`
    : durableCompletionRejected
      ? null
      : input.durable.terminalEvent;
  const disagreement = observedStreamTerminal !== durableTerminal;
  // A current-head approval proves governed completion only when the stream did
  // not observe a later settled failure such as a blocked merge preview.
  const useDurable = durableTerminal !== null
    && disagreement
    && !(input.preserveObservedFailure === true && streamTerminal === TurnStatus.Failed);
  const classification = classifyArmStatus({
    status: useDurable ? durableTerminal : eligibleStreamStatus,
    source: useDurable ? 'durable-state-reconciliation' : 'stream',
    errors: input.streamErrors,
  });
  const durableStateReceipt: Omit<DurablePacketState, 'recoveredDiff'> = {
    view: input.durable.view,
    completionBoundary: input.durable.completionBoundary,
    packetId: input.durable.packetId,
    laneId: input.durable.laneId,
    laneStatus: input.durable.laneStatus,
    laneOutcome: input.durable.laneOutcome,
    branch: input.durable.branch,
    sessionKey: input.durable.sessionKey,
    worktreePath: input.durable.worktreePath,
    worktreeExists: input.durable.worktreeExists,
    headSha: input.durable.headSha,
    diffBase: input.durable.diffBase,
    terminalStatus: durableTerminal,
    terminalEvent: durableTerminalEvent,
    eventCount: input.durable.eventCount,
    error: input.durable.error,
  };
  return {
    ...classification,
    classificationReason: useDurable
      ? `durable state won: ${durableTerminalEvent ?? durableTerminal}; ` +
        `stream terminal status was ${streamTerminal ?? 'not observed'}`
      : governedBoundary
        && observedStreamTerminal === TurnStatus.Completed
        && !governedReviewCompleted
        ? 'governed completion rejected: no durable approved review for the current HEAD'
        : classification.classificationReason,
    durableReconciliation: {
      ...durableStateReceipt,
      streamStatus: input.streamStatus,
      durableStatus: durableTerminal,
      disagreement,
    },
  };
}
