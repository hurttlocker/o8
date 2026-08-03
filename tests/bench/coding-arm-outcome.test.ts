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
} from '../../scripts/bench/coding-durable-reconciliation';
import { endToEndMeasurementNotes } from '../../scripts/bench/coding-end-to-end';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
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
});
