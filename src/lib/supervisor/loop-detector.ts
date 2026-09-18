/**
 * Loop detection from tool-call patterns (#2448, program #2481). RECORD-ONLY,
 * ADVISORY.
 *
 * When `judgment.provider` is on, the supervisor tick hands its due agents to
 * `startLoopChecks`. For each running agent bound to an active packet lane,
 * a detached check reads the runtime transcript, builds the state from the
 * last 20 tool calls (tool name, argument hash, output head, error flag, and
 * counts; no assistant text, no title, no report) and asks the locked
 * `LOOP_QUESTION` in one bounded attempt. Every answer is recorded as a
 * `loop_check` lane event, and askJudgment writes the receipt.
 *
 * Two consecutive answers at or above the PROVISIONAL band (1 -
 * ABSTAIN_CONFIDENCE) raise one `possible_loop` event and one inbox item per
 * run, quoting the repeated call and the receipt id. An answer at or below
 * ABSTAIN_CONFIDENCE clears the streak. Nothing is stopped, steered, or
 * gated; the replay label `loop` scores the recorded answers.
 */
import { createHash } from 'node:crypto';

import { askJudgment, type AskJudgmentOptions } from '@/lib/judgment/client';
import { LOOP_QUESTION } from '@/lib/judgment/questions';
import { normalizeForJudgment } from '@/lib/judgment/text-scan';
import { ABSTAIN_CONFIDENCE } from '@/lib/judgment/types';
import type { TranscriptEntry, WatchedAgent } from './agent-supervisor-types';

export const LOOP_DETECTOR_SURFACE = 'loop-detector';
/** Tool calls in the window. */
export const LOOP_WINDOW = 20;
/** PROVISIONAL: no replay number exists yet. */
export const LOOP_BAND = 1 - ABSTAIN_CONFIDENCE;
const RESULT_HEAD_CHARS = 200;
const TRANSCRIPT_LIMIT = 120;
/** At most one check per lane per interval, and only when a new tool call landed. */
const MIN_INTERVAL_MS = 60_000;
/** One bounded attempt: the check never retries. */
const PRODUCTION_TRANSPORT: AskJudgmentOptions = { timeoutMs: 8_000, maxAttempts: 1 };
const QUESTIONS = { loop: LOOP_QUESTION } as const;
const ERROR_RE = /\b(error|errors|failed|failure|fail|exception|traceback|panic|denied|not found|no such file|enoent|exit(?:ed with)? code [1-9]\d*)\b/i;

export interface LoopToolCall {
  index: number;
  toolName: string;
  /** sha256 of the call's normalized arguments (the transcript's call text), first 16 hex chars. */
  argsHash: string;
  /** First 200 chars of the call's output, normalized; null when no output was recorded. */
  resultHead: string | null;
  failed: boolean;
}

export interface LoopCounts {
  toolCalls: number;
  distinctTools: number;
  distinctArgHashes: number;
  /** Runs of two or more consecutive calls with the same argument hash. */
  repeatedArgHashRuns: number;
}

export interface LoopState {
  window: LoopToolCall[];
  counts: LoopCounts;
}

export interface LoopPattern {
  toolName: string;
  argsHash: string;
  count: number;
  resultHead: string | null;
  failed: boolean;
}

interface LaneLoopMemory {
  /** Last two answers, oldest first. */
  ring: Array<{ p: number; receiptId: string | null }>;
  lastToolEntryId: string | null;
  lastCheckedAt: number;
  /** Session keys this lane already raised `possible_loop` for. */
  raisedRuns: Set<string>;
}

const memory = new Map<string, LaneLoopMemory>();
const inFlight = new Map<string, Promise<void>>();
let transportOverride: AskJudgmentOptions | undefined;
let minIntervalMs = MIN_INTERVAL_MS;

/** Test-only: point the check at a local endpoint fixture and set the per-lane interval. */
export function setLoopDetectorForTests(options: { transport?: AskJudgmentOptions; minIntervalMs?: number } | undefined): void {
  transportOverride = options?.transport;
  minIntervalMs = options?.minIntervalMs ?? MIN_INTERVAL_MS;
  memory.clear();
}

/** Resolves when every check in flight has settled. */
export async function waitForLoopChecks(): Promise<void> {
  await Promise.all([...inFlight.values()]);
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const normalizeArgs = (text: string) => normalizeForJudgment(text).replace(/\s+/g, ' ').trim();
const isToolCall = (entry: TranscriptEntry) => entry.role === 'tool';
/** Codex records tool output as `system`; some runtimes use `tool-output`. */
const isToolOutput = (entry: TranscriptEntry) => entry.role === 'system' || entry.role === 'tool-output';

/** The state sent to the provider. Pure; exported for the state-shape tests. */
export function buildLoopState(entries: readonly TranscriptEntry[]): LoopState {
  const calls: LoopToolCall[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isToolCall(entry)) continue;
    const next = entries[index + 1];
    const output = next && isToolOutput(next) ? normalizeForJudgment(next.text) : null;
    calls.push({
      index: calls.length,
      toolName: entry.toolName?.trim() || 'tool',
      argsHash: hash(normalizeArgs(entry.text)),
      resultHead: output === null ? null : output.slice(0, RESULT_HEAD_CHARS),
      failed: output !== null && ERROR_RE.test(output),
    });
  }
  const window = calls.slice(-LOOP_WINDOW).map((call, index) => ({ ...call, index }));
  let repeatedArgHashRuns = 0;
  for (let index = 1; index < window.length; index += 1) {
    const repeats = window[index].argsHash === window[index - 1].argsHash;
    const runStart = index === 1 || window[index - 1].argsHash !== window[index - 2].argsHash;
    if (repeats && runStart) repeatedArgHashRuns += 1;
  }
  return {
    window,
    counts: {
      toolCalls: window.length,
      distinctTools: new Set(window.map((call) => call.toolName)).size,
      distinctArgHashes: new Set(window.map((call) => call.argsHash)).size,
      repeatedArgHashRuns,
    },
  };
}

/** The most repeated call in the window, with the output of its latest occurrence. */
export function repeatedPattern(window: readonly LoopToolCall[]): LoopPattern | null {
  const byHash = new Map<string, LoopToolCall[]>();
  for (const call of window) byHash.set(call.argsHash, [...(byHash.get(call.argsHash) ?? []), call]);
  const top = [...byHash.values()].sort((a, b) => b.length - a.length)[0];
  if (!top) return null;
  const latest = top[top.length - 1];
  return { toolName: latest.toolName, argsHash: latest.argsHash, count: top.length, resultHead: latest.resultHead, failed: latest.failed };
}

function inboxExcerpt(pattern: LoopPattern, receiptId: string | null): string {
  const quoted = pattern.resultHead ? `"${pattern.resultHead.replace(/\s+/g, ' ').trim()}"` : 'no output recorded';
  return `Advisory, nothing stopped: ${pattern.toolName} called ${pattern.count} times with the same arguments (${pattern.argsHash}), output ${quoted}; receipt ${receiptId ?? 'none'}`;
}

/**
 * Ask the loop question for one agent's transcript and record the answer.
 * Never throws. No-op when the agent has no active packet lane or no tool calls.
 */
export async function assessLoop(agent: Pick<WatchedAgent, 'surfaceId'>, entries: readonly TranscriptEntry[]): Promise<void> {
  try {
    const { findLaneBySession } = await import('@/lib/lane/registry');
    const lane = findLaneBySession(agent.surfaceId);
    if (!lane?.packetId) return;
    const state = buildLoopState(entries);
    if (state.window.length === 0) return;

    const result = await askJudgment({
      state,
      questions: QUESTIONS,
      context: { surface: LOOP_DETECTOR_SURFACE, laneId: lane.id, packetId: lane.packetId },
    }, transportOverride ?? PRODUCTION_TRANSPORT);
    if (!result) return;
    const p = result.answers.loop.noul;

    const { recordLaneEvent } = await import('@/lib/lane/events');
    recordLaneEvent(lane.id, 'loop_check', 'system', {
      receiptId: result.receiptId, packetId: lane.packetId, p, window: state.window, counts: state.counts,
    });

    const laneMemory = memoryFor(lane.id);
    if (p <= ABSTAIN_CONFIDENCE) {
      laneMemory.ring = [];
      return;
    }
    laneMemory.ring = [...laneMemory.ring, { p, receiptId: result.receiptId }].slice(-2);
    const streak = laneMemory.ring.length === 2 && laneMemory.ring.every((answer) => answer.p >= LOOP_BAND);
    if (!streak || laneMemory.raisedRuns.has(agent.surfaceId)) return;
    const pattern = repeatedPattern(state.window);
    if (!pattern) return;
    laneMemory.raisedRuns.add(agent.surfaceId);

    recordLaneEvent(lane.id, 'possible_loop', 'system', {
      receiptId: result.receiptId,
      receiptIds: laneMemory.ring.map((answer) => answer.receiptId),
      packetId: lane.packetId,
      sessionKey: agent.surfaceId,
      p: laneMemory.ring.map((answer) => answer.p),
      band: LOOP_BAND,
      advisory: true,
      pattern,
    });
    const { enqueueInboxItem } = await import('./inbox');
    enqueueInboxItem({
      repoPath: lane.repoPath,
      packetId: lane.packetId,
      kind: 'possible_loop',
      payload: {
        laneId: lane.id,
        sessionKey: agent.surfaceId,
        receiptId: result.receiptId,
        advisory: true,
        pattern,
        errorExcerpt: inboxExcerpt(pattern, result.receiptId),
      },
    });
  } catch (error) {
    console.warn('[loop-detector] skipped:', error instanceof Error ? error.message : 'error');
  }
}

function memoryFor(laneId: string): LaneLoopMemory {
  let laneMemory = memory.get(laneId);
  if (!laneMemory) {
    laneMemory = { ring: [], lastToolEntryId: null, lastCheckedAt: 0, raisedRuns: new Set() };
    memory.set(laneId, laneMemory);
  }
  return laneMemory;
}

/**
 * Start detached loop checks for the tick's due agents. Returns immediately
 * and never throws. The caller checks the judgment setting first.
 */
export function startLoopChecks(
  agents: readonly WatchedAgent[],
  fetchTranscript: (sessionKey: string, limit: number) => Promise<TranscriptEntry[]>,
): void {
  for (const agent of agents) {
    if (agent.completionReported || (agent.lastStatus !== 'running' && agent.lastStatus !== 'waiting')) continue;
    if (inFlight.has(agent.surfaceId)) continue;
    const promise = (async () => {
      const { findLaneBySession } = await import('@/lib/lane/registry');
      const lane = findLaneBySession(agent.surfaceId);
      if (!lane?.packetId) return;
      const laneMemory = memoryFor(lane.id);
      if (Date.now() - laneMemory.lastCheckedAt < minIntervalMs) return;
      const entries = await fetchTranscript(agent.surfaceId, TRANSCRIPT_LIMIT);
      const lastToolEntryId = [...entries].reverse().find(isToolCall)?.id ?? null;
      if (!lastToolEntryId || lastToolEntryId === laneMemory.lastToolEntryId) return;
      laneMemory.lastToolEntryId = lastToolEntryId;
      laneMemory.lastCheckedAt = Date.now();
      await assessLoop(agent, entries);
    })()
      .catch((error) => {
        console.warn('[loop-detector] skipped:', error instanceof Error ? error.message : 'error');
      })
      .finally(() => {
        if (inFlight.get(agent.surfaceId) === promise) inFlight.delete(agent.surfaceId);
      });
    inFlight.set(agent.surfaceId, promise);
  }
}
