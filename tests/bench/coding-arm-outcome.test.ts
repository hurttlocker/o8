import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  TurnStatus,
  classifyArmStatus,
  countArmOutcomes,
  ginsuTurnStatus,
  isScorableArmOutcome,
} from '../../scripts/bench/coding-arm-outcome';
import {
  readDurablePacketState,
  reconcileArmWithDurableState,
  type DurablePacketState,
} from '../../scripts/bench/coding-durable-reconciliation';
import { endToEndMeasurementNotes } from '../../scripts/bench/coding-end-to-end';
import { governedPipelineTerminalStatus } from '../../scripts/bench/coding-end-to-end-review';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function governedDurableState(
  overrides: Partial<DurablePacketState> = {},
): DurablePacketState {
  return {
    view: 'summary',
    completionBoundary: 'governed-review',
    packetId: 'pkt-governed',
    laneId: 'lane-governed',
    laneStatus: 'completed',
    laneOutcome: null,
    branch: 'packet/governed',
    sessionKey: 'session-governed',
    worktreePath: null,
    worktreeExists: false,
    headSha: null,
    diffBase: null,
    recoveredDiff: '',
    terminalStatus: TurnStatus.Completed,
    terminalEvent: 'status_change@2026-08-03T12:00:00.000Z',
    eventCount: 1,
    error: null,
    ...overrides,
  };
}

describe('coding benchmark arm outcomes', () => {
  it('recovers a completed packet from durable state after the stream is lost', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o8-coding-durable-'));
    const worktree = path.join(root, 'packet-worktree');
    fs.mkdirSync(worktree);
    try {
      git(worktree, ['init', '-q']);
      git(worktree, ['config', 'user.email', 'benchmark@example.invalid']);
      git(worktree, ['config', 'user.name', 'Benchmark Test']);
      fs.writeFileSync(path.join(worktree, 'result.txt'), 'before\n');
      git(worktree, ['add', 'result.txt']);
      git(worktree, ['commit', '-q', '-m', 'base']);
      const base = git(worktree, ['rev-parse', 'HEAD']);
      fs.writeFileSync(path.join(worktree, 'result.txt'), 'after\n');
      git(worktree, ['add', 'result.txt']);
      git(worktree, ['commit', '-q', '-m', 'completed packet']);

      const database = new Database(path.join(root, 'cortex-ide.db'));
      database.exec(`
        CREATE TABLE lanes (
          id TEXT PRIMARY KEY,
          packet_id TEXT NOT NULL,
          status TEXT NOT NULL,
          outcome TEXT,
          branch TEXT NOT NULL,
          worktree_path TEXT,
          session_key TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE lane_events (
          lane_id TEXT NOT NULL,
          verb TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          timestamp TEXT NOT NULL
        );
      `);
      database.prepare(`
        INSERT INTO lanes (
          id, packet_id, status, outcome, branch, worktree_path, session_key, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('lane-test', 'pkt-test', 'reviewing', null, 'packet/test', worktree, 'session-test', '2026-08-03');
      database.prepare(`
        INSERT INTO lane_events (lane_id, verb, payload_json, timestamp)
        VALUES (?, ?, ?, ?)
      `).run(
        'lane-test',
        'runtime_process_exit',
        JSON.stringify({ exitCode: 0, classification: 'clean-exit', completedTurn: true }),
        '2026-08-03T12:00:00.000Z',
      );
      database.close();

      const durable = readDurablePacketState({ packetId: 'pkt-test', expectedBase: base, dataDir: root });
      const result = reconcileArmWithDurableState({
        streamStatus: null,
        streamErrors: [{ message: 'stream disconnected', willRetry: false }],
        durable,
      });

      expect(result).toMatchObject({
        outcome: 'valid',
        terminalStatus: TurnStatus.Completed,
        resultSource: 'durable-state-reconciliation',
        durableReconciliation: {
          view: 'full',
          disagreement: true,
          streamStatus: null,
          durableStatus: TurnStatus.Completed,
        },
      });
      expect(durable.recoveredDiff).toContain('+after');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps an observed failure measurable and eligible for scoring', () => {
    const result = classifyArmStatus({ status: TurnStatus.Failed, source: 'stream' });

    expect(result.outcome).toBe('failed');
    expect(result.terminalStatus).toBe(TurnStatus.Failed);
    expect(isScorableArmOutcome(result.outcome)).toBe(true);
    expect(countArmOutcomes([result])).toEqual({ valid: 0, failed: 1, invalid: 0 });
  });

  it('keeps a governed review timeout failed and eligible for scoring', () => {
    const result = classifyArmStatus({
      status: governedPipelineTerminalStatus('timeout'),
      source: 'stream',
      errors: [{
        message: 'governed pipeline timed out before a durable approved review for the current HEAD',
        willRetry: false,
      }],
    });

    expect(result.outcome).toBe('failed');
    expect(result.terminalStatus).toBe(TurnStatus.Failed);
    expect(isScorableArmOutcome(result.outcome)).toBe(true);
  });

  it('keeps a completed no-diff turn valid and eligible for scoring', () => {
    const status = ginsuTurnStatus({
      status: 0,
      signal: null,
      timedOut: false,
      stdout: 'No changes were necessary.',
      stderr: '',
    });
    const result = classifyArmStatus({ status, source: 'stream' });
    const notes = endToEndMeasurementNotes({
      condition: 'adhoc-claude',
      expectedBase: 'abc123',
      changedFiles: [],
      commandsPassed: true,
      mechanicalPassed: true,
      durableReviewApproved: null,
      reviewAttempts: 0,
      maxReviewAttempts: 3,
      diffBase: null,
      diffTruncated: false,
      pipelineFailureReason: null,
    });

    expect(notes).toContain('no shipped diff produced');
    expect(result.outcome).toBe('valid');
    expect(result.terminalStatus).toBe(TurnStatus.Completed);
    expect(isScorableArmOutcome(result.outcome)).toBe(true);
  });

  it('classifies a missing terminal event as invalid and never as failed', () => {
    const status = ginsuTurnStatus({
      status: 1,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: 'timed out waiting for the worker',
    });
    const result = classifyArmStatus({ status, source: 'stream' });

    expect(result.outcome).toBe('invalid');
    expect(result.terminalStatus).toBeNull();
    expect(isScorableArmOutcome(result.outcome)).toBe(false);
    expect(countArmOutcomes([result])).toEqual({ valid: 0, failed: 0, invalid: 1 });
  });

  it('keeps interruption distinct from failure', () => {
    const result = classifyArmStatus({ status: TurnStatus.Interrupted, source: 'stream' });

    expect(result.outcome).toBe('invalid');
    expect(result.terminalStatus).toBe(TurnStatus.Interrupted);
    expect(result.classificationReason).toContain('interruption is not a failure');
  });

  it('does not treat a clean worker exit on a running governed lane as completion', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o8-coding-governed-running-'));
    const worktree = path.join(root, 'packet-worktree');
    fs.mkdirSync(worktree);
    try {
      git(worktree, ['init', '-q']);
      git(worktree, ['config', 'user.email', 'benchmark@example.invalid']);
      git(worktree, ['config', 'user.name', 'Benchmark Test']);
      fs.writeFileSync(path.join(worktree, 'result.txt'), 'base\n');
      git(worktree, ['add', 'result.txt']);
      git(worktree, ['commit', '-q', '-m', 'base']);
      const base = git(worktree, ['rev-parse', 'HEAD']);
      fs.writeFileSync(path.join(worktree, 'implementation-notes.md'), 'claimed work\n');
      git(worktree, ['add', 'implementation-notes.md']);
      git(worktree, ['commit', '-q', '-m', 'worker output']);

      const database = new Database(path.join(root, 'cortex-ide.db'));
      database.exec(`
        CREATE TABLE lanes (
          id TEXT PRIMARY KEY,
          packet_id TEXT NOT NULL,
          status TEXT NOT NULL,
          outcome TEXT,
          branch TEXT NOT NULL,
          worktree_path TEXT,
          session_key TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE lane_events (
          lane_id TEXT NOT NULL,
          verb TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          timestamp TEXT NOT NULL
        );
      `);
      database.prepare(`
        INSERT INTO lanes (
          id, packet_id, status, outcome, branch, worktree_path, session_key, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('lane-running', 'pkt-running', 'running', null, 'packet/running', worktree, 'session-running', '2026-08-03');
      database.prepare(`
        INSERT INTO lane_events (lane_id, verb, payload_json, timestamp)
        VALUES (?, ?, ?, ?)
      `).run(
        'lane-running',
        'runtime_process_exit',
        JSON.stringify({ exitCode: 0, classification: 'clean-exit', completedTurn: true }),
        '2026-08-03T12:00:00.000Z',
      );
      database.close();

      const durable = readDurablePacketState({
        packetId: 'pkt-running',
        expectedBase: base,
        dataDir: root,
        completionBoundary: 'governed-review',
      });
      const result = reconcileArmWithDurableState({
        streamStatus: null,
        durable,
        governedReview: null,
        preserveObservedFailure: true,
      });

      expect(durable.terminalStatus).toBeNull();
      expect(durable.recoveredDiff).toContain('implementation-notes.md');
      expect(result.outcome).toBe('invalid');
      expect(result.terminalStatus).toBeNull();
      expect(result.durableReconciliation).toMatchObject({
        completionBoundary: 'governed-review',
        laneStatus: 'running',
        durableStatus: null,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not score a stream-lost governed arm without an approved review', () => {
    const result = reconcileArmWithDurableState({
      streamStatus: governedPipelineTerminalStatus('stream-lost'),
      streamErrors: [{ message: 'mission wait lost the governed packet', willRetry: false }],
      durable: governedDurableState(),
      governedReview: null,
      preserveObservedFailure: true,
    });

    expect(result.outcome).toBe('invalid');
    expect(result.terminalStatus).toBeNull();
    expect(result.resultSource).toBe('stream');
    expect(result.durableReconciliation).toMatchObject({
      completionBoundary: 'governed-review',
      streamStatus: null,
      durableStatus: null,
      terminalEvent: null,
      disagreement: false,
    });
  });

  it.each([
    { label: 'status_change completed', laneStatus: 'running', laneOutcome: null, eventStatus: 'completed' },
    { label: 'completed lane', laneStatus: 'completed', laneOutcome: null, eventStatus: null },
    { label: 'archived merged lane', laneStatus: 'archived', laneOutcome: 'merged', eventStatus: null },
    { label: 'archived no_changes lane', laneStatus: 'archived', laneOutcome: 'no_changes', eventStatus: null },
    { label: 'archived pr_opened lane', laneStatus: 'archived', laneOutcome: 'pr_opened', eventStatus: null },
  ])('does not complete a governed arm from $label without an approved review', ({
    laneStatus,
    laneOutcome,
    eventStatus,
  }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o8-coding-governed-terminal-'));
    try {
      const database = new Database(path.join(root, 'cortex-ide.db'));
      database.exec(`
        CREATE TABLE lanes (
          id TEXT PRIMARY KEY,
          packet_id TEXT NOT NULL,
          status TEXT NOT NULL,
          outcome TEXT,
          branch TEXT NOT NULL,
          worktree_path TEXT,
          session_key TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE lane_events (
          lane_id TEXT NOT NULL,
          verb TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          timestamp TEXT NOT NULL
        );
      `);
      database.prepare(`
        INSERT INTO lanes (
          id, packet_id, status, outcome, branch, worktree_path, session_key, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'lane-terminal',
        'pkt-terminal',
        laneStatus,
        laneOutcome,
        'packet/terminal',
        null,
        'session-terminal',
        '2026-08-03',
      );
      if (eventStatus) {
        database.prepare(`
          INSERT INTO lane_events (lane_id, verb, payload_json, timestamp)
          VALUES (?, ?, ?, ?)
        `).run(
          'lane-terminal',
          'status_change',
          JSON.stringify({ status: eventStatus }),
          '2026-08-03T12:00:00.000Z',
        );
      }
      database.close();

      const durable = readDurablePacketState({
        packetId: 'pkt-terminal',
        expectedBase: 'unused-base',
        dataDir: root,
        completionBoundary: 'governed-review',
      });
      const result = reconcileArmWithDurableState({
        streamStatus: null,
        durable,
        governedReview: null,
        preserveObservedFailure: true,
      });

      expect(durable.terminalStatus).toBeNull();
      expect(result.outcome).toBe('invalid');
      expect(result.terminalStatus).toBeNull();
      expect(result.durableReconciliation.durableStatus).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
