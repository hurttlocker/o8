import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  crashSurvivableOrchestratorEnabled,
  createOrchestratorTurnRecord,
  createOrchestratorTurnRecordForFiles,
  finishOrchestratorTurn,
  isPidAlive,
  isRehydratedTurnAlive,
  listActiveOrchestratorTurns,
  listOrchestratorTurnsForThread,
  readJsonlLines,
} from './orchestrator-crash-survival';
import { rehydrateCodexOrchestratorTurns } from './codex-orchestrator-session';
import { PROCESS_TIMEOUT_MS } from './orchestrator-session-core';

describe('orchestrator crash survival helpers', () => {
  let root: string;
  let priorDataDir: string | undefined;
  let priorFlag: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'o8-orch-crash-'));
    priorDataDir = process.env.CORTEX_IDE_DATA_DIR;
    priorFlag = process.env.O8_CRASH_SURVIVABLE_ORCHESTRATOR;
    process.env.CORTEX_IDE_DATA_DIR = root;
    delete process.env.O8_CRASH_SURVIVABLE_ORCHESTRATOR;
  });

  afterEach(() => {
    if (priorDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
    else process.env.CORTEX_IDE_DATA_DIR = priorDataDir;
    if (priorFlag === undefined) delete process.env.O8_CRASH_SURVIVABLE_ORCHESTRATOR;
    else process.env.O8_CRASH_SURVIVABLE_ORCHESTRATOR = priorFlag;
    rmSync(root, { recursive: true, force: true });
  });

  it('defaults on and accepts the worker-style opt-out values', () => {
    expect(crashSurvivableOrchestratorEnabled()).toBe(true);
    process.env.O8_CRASH_SURVIVABLE_ORCHESTRATOR = '0';
    expect(crashSurvivableOrchestratorEnabled()).toBe(false);
    process.env.O8_CRASH_SURVIVABLE_ORCHESTRATOR = 'false';
    expect(crashSurvivableOrchestratorEnabled()).toBe(false);
    process.env.O8_CRASH_SURVIVABLE_ORCHESTRATOR = '1';
    expect(crashSurvivableOrchestratorEnabled()).toBe(true);
  });

  it('persists and clears active turn records', () => {
    const record = createOrchestratorTurnRecord({
      backend: 'codex',
      sessionName: 'cortex-codex-orchestrator-test',
      repoPath: root,
      threadId: 'thoughts-test',
      pid: process.pid,
      assistantMessageId: 'assistant-1',
    });

    expect(listActiveOrchestratorTurns()).toHaveLength(1);
    expect(listActiveOrchestratorTurns()[0]).toMatchObject({
      id: record.id,
      backend: 'codex',
      assistantMessageId: 'assistant-1',
    });

    finishOrchestratorTurn(record);
    expect(listActiveOrchestratorTurns()).toHaveLength(0);
  });

  it('task #8 — a settled turn stays queryable per thread with its outcome', () => {
    const record = createOrchestratorTurnRecord({
      backend: 'claude',
      sessionName: 'cortex-orchestrator-ledger',
      repoPath: root,
      threadId: 'thoughts-ledger',
      pid: process.pid,
      assistantMessageId: 'assistant-ledger',
    });

    finishOrchestratorTurn(record, 'failed');
    // Settled ≠ active: crash recovery must not re-tail it…
    expect(listActiveOrchestratorTurns()).toHaveLength(0);
    // …but the ledger still answers "how did this thread's last turn end" —
    // the server truth the client reconciles phantom timers / dropped
    // transcript turns against. Old behavior deleted the record here.
    const turns = listOrchestratorTurnsForThread('thoughts-ledger');
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      id: record.id,
      outcome: 'failed',
      assistantMessageId: 'assistant-ledger',
    });
    expect(turns[0].settledAt).toBeTypeOf('number');
  });

  it('reads jsonl lines from an offset', () => {
    const record = createOrchestratorTurnRecord({
      backend: 'claude',
      sessionName: 'cortex-orchestrator-test',
      repoPath: root,
      pid: process.pid,
    });
    writeFileSync(record.stdoutPath, '{"type":"a"}\n', 'utf8');
    const first = readJsonlLines(record.stdoutPath);
    expect(first.lines).toEqual(['{"type":"a"}']);

    writeFileSync(record.stdoutPath, '{"type":"a"}\n{"type":"b"}\n', 'utf8');
    const second = readJsonlLines(record.stdoutPath, first.offset);
    expect(second.lines).toEqual(['{"type":"b"}']);
  });

  it('keeps byte offsets exact across Unicode output and waits for complete lines', () => {
    const outputPath = join(root, 'unicode.jsonl');
    const firstLine = `${JSON.stringify({ type: 'text', value: 'I’ll verify o8' })}\n`;
    const partialSecond = JSON.stringify({ type: 'text', value: 'final answer' });
    writeFileSync(outputPath, firstLine + partialSecond, 'utf8');

    const first = readJsonlLines(outputPath);
    expect(first.lines).toEqual([firstLine.trim()]);
    expect(first.offset).toBe(Buffer.byteLength(firstLine, 'utf8'));
    expect(readJsonlLines(outputPath, first.offset)).toEqual({ lines: [], offset: first.offset });

    writeFileSync(outputPath, `${firstLine}${partialSecond}\n`, 'utf8');
    expect(readJsonlLines(outputPath, first.offset).lines).toEqual([partialSecond]);
  });

  it('checks pid liveness without throwing', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0)).toBe(false);
  });

  it('bounds a rehydrated turn by wall clock so a live-looking pid cannot hold a session busy forever', () => {
    // process.pid is alive AND signalable, so isPidAlive answers true every
    // time — the same answer a RECYCLED pid owned by another user gives, since
    // isPidAlive counts EPERM as alive. Nothing else settles the turn: the
    // watchdog that would have killed it died with the process that owned it.
    const record = createOrchestratorTurnRecord({
      backend: 'codex',
      sessionName: 'cortex-codex-orchestrator-stale',
      repoPath: root,
      threadId: 'thoughts-stale',
      pid: process.pid,
    });
    const recordFile = join(root, 'orchestrator-turns', `${record.id}.json`);
    const stored = JSON.parse(readFileSync(recordFile, 'utf8')) as { startedAt: number };
    stored.startedAt = Date.now() - (PROCESS_TIMEOUT_MS + 60_000);
    writeFileSync(recordFile, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');

    expect(isRehydratedTurnAlive({ pid: process.pid, startedAt: stored.startedAt }, PROCESS_TIMEOUT_MS)).toBe(false);

    const count = rehydrateCodexOrchestratorTurns();

    expect(count).toBe(1);
    // The turn SETTLED rather than being left tailing behind a pid that never
    // reports dead. An unsettled record stays active and its session stays busy.
    expect(listActiveOrchestratorTurns()).toHaveLength(0);
  });

  it('replays a dead codex turn record into rebound events', () => {
    const record = createOrchestratorTurnRecord({
      backend: 'codex',
      sessionName: 'cortex-codex-orchestrator-replay',
      repoPath: root,
      threadId: 'thoughts-replay',
      pid: 0,
      assistantMessageId: 'assistant-replay',
    });
    writeFileSync(
      record.stdoutPath,
      [
        JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread-replay' }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'recovered text' } }),
      ].join('\n') + '\n',
      'utf8',
    );

    const events: Array<{ type: string }> = [];
    const count = rehydrateCodexOrchestratorTurns({
      onReboundEvent: (_record, event) => { events.push(event); },
    });

    expect(count).toBe(1);
    expect(events).toMatchObject([
      { type: 'text', text: 'recovered text' },
      { type: 'done', sessionId: 'codex-thread-replay' },
    ]);
    expect(listActiveOrchestratorTurns()).toHaveLength(0);
  });

  it('starts replay at the durable stdout offset', () => {
    const stdoutPath = join(root, 'offset.jsonl');
    const stderrPath = join(root, 'offset.stderr.log');
    const previousTurn = `${JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'old text' } })}\n`;
    writeFileSync(
      stdoutPath,
      previousTurn + `${JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'new text' } })}\n`,
      'utf8',
    );
    writeFileSync(stderrPath, '', 'utf8');
    createOrchestratorTurnRecordForFiles({
      backend: 'codex',
      sessionName: 'cortex-codex-orchestrator-offset',
      repoPath: root,
      pid: 0,
      stdoutPath,
      stderrPath,
      stdoutOffset: Buffer.byteLength(previousTurn, 'utf8'),
    });

    const texts: string[] = [];
    rehydrateCodexOrchestratorTurns({
      onReboundEvent: (_record, event) => {
        if (event.type === 'text') texts.push(event.text);
      },
    });

    expect(texts).toEqual(['new text']);
    expect(listActiveOrchestratorTurns()).toHaveLength(0);
  });
});
