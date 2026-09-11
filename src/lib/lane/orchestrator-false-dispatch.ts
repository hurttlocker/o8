/**
 * #2142 — false dispatch: the orchestrator narrates a dispatch it never made.
 *
 * `settleOrchestratorTurn` has always been able to SEE this: it holds both the
 * number of `cortex_launch_agent` calls the turn made and the assistant text the
 * turn produced. When the text claims a dispatch and the call count is zero, the
 * turn is fiction — no lane, no worktree, no worker. Until now that produced a
 * `console.warn` in `ws-server.log` and then a normal `done`, so every consumer
 * (thread UI, mission surface, any automation waiting on lanes) was told the run
 * succeeded. A false success is worse than a failure: a failure is visible and
 * retryable in seconds, a fabrication costs however long it takes someone to
 * notice the work does not exist.
 *
 * This module owns the two decisions that turn the existing telemetry into a
 * consequence, kept pure so both can be tested without a live `claude` proc:
 *   1. does this turn's text CLAIM a dispatch (`claimsDispatch`), and
 *   2. what happens when it does (`runTurnWithFalseDispatchRetry`).
 */
import type { OrchestratorEvent } from './orchestrator-stream-events';

type DoneEvent = Extract<OrchestratorEvent, { type: 'done' }>;

/**
 * Verbs that assert a dispatch actually happened (or is happening).
 *
 * #2142 decision — coverage vs false positives. The original list was
 * `dispatched|launched|fired|polling|launching|kicked off`. Two members were
 * pure false-positive surface and are dropped:
 *   - bare `fired`: "the watchdog fired", "the hook fired" claim nothing about
 *     agents. `fired off` (the phrasing that does claim a dispatch) is kept.
 *   - `polling`: "I'll keep polling the mission" is a turn that explicitly did
 *     NOT dispatch. It never asserted a dispatch on its own.
 * `dispatching` and `spun up` are added to recover coverage of the phrasings
 * seen in the reported traces. Net: this matches strictly fewer healthy turns
 * and the same failing ones. A turn that says "I fired off agent X" with zero
 * launch calls is still caught; one that says "the retry timer fired" is not.
 */
const DISPATCH_VERB_PATTERN = /\b(?:dispatched|dispatching|launched|launching|kicked off|fired off|spun up)\b/i;

/**
 * Negation, scoped to the sentence carrying the verb.
 *
 * This is the documented false positive from the issue thread: the detector
 * flagged a turn whose text said the opposite of a dispatch —
 *   "Nothing dispatched. The three demo-site packets from the previous turn are
 *    still out there untouched by this turn."
 * Under the old bare-keyword match that was only a stray `console.warn`. Under
 * this change it would FAIL a healthy turn and feed the model a correction
 * telling it to launch agents it deliberately did not launch — a false positive
 * that causes an unwanted dispatch. The guard is mandatory, not cosmetic.
 */
const DISPATCH_NEGATION_PATTERN = /\b(?:no|not|n't|nothing|none|never|without|cannot|unable|instead of|rather than|before|would|should|could|will|can|if)\b/i;

/** Split on sentence terminators AND newlines — bullet lists rarely punctuate. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/g).filter((s) => s.trim().length > 0);
}

/**
 * True when some sentence asserts a dispatch and that same sentence is not
 * negated or hypothetical. Sentence-scoped on purpose: a negation elsewhere in a
 * long reply must not mask a real claim, and a real claim elsewhere must not
 * override an explicit "nothing dispatched".
 */
export function claimsDispatch(text: string): boolean {
  for (const sentence of sentences(text)) {
    if (!DISPATCH_VERB_PATTERN.test(sentence)) continue;
    if (DISPATCH_NEGATION_PATTERN.test(sentence)) continue;
    return true;
  }
  return false;
}

/**
 * A turn is a false dispatch when it ran to a real stream `result` (not a
 * timeout / abort / crash / LOCKOUT — those settle with `completedResult:false`
 * and are excluded), produced no error, made ZERO launch calls, and still told
 * the operator it dispatched.
 */
export function isFalseDispatchTurn(input: {
  completedResult: boolean;
  error: Error | null;
  launchAgentCallCount: number;
  assistantText: string;
}): boolean {
  if (!input.completedResult) return false;
  if (input.error) return false;
  if (input.launchAgentCallCount >= 1) return false;
  return claimsDispatch(input.assistantText);
}

export const FALSE_DISPATCH_RETRY_REASON = 'false-dispatch';

/** Shown in the thread at the attempt boundary so the retry is not invisible. */
export const FALSE_DISPATCH_RETRY_NOTICE =
  'That reply claimed a dispatch but made no launch call, so nothing was started. '
  + 'Discarding it and retrying the turn once.';

/**
 * What the retry actually retries (#2142 design decision).
 *
 * NOT a bare resend of the operator's message, and NOT a fresh session:
 *   - A resend into the same warm session leaves the model's own false claim in
 *     its own context with no corrective signal. The most likely outcome is that
 *     it repeats itself and the retry costs a turn for nothing.
 *   - A fresh session throws away the repo exploration and the packet plan the
 *     turn just built, so the retry has to redo all of it and may well produce a
 *     different plan than the one the operator just read.
 * The one thing with direct evidence behind it is an explicit correction: the
 * issue thread reports that "told explicitly to call `cortex_launch_agent`, the
 * model does call it". So the retry is a correction turn on the same warm
 * session — it keeps the plan, names the contradiction, and asks for the call.
 */
export const FALSE_DISPATCH_CORRECTION = [
  'STOP. Your previous reply reported that you dispatched agents, but you made no `cortex_launch_agent` call in that turn, so nothing was launched: no lane, no worktree, no worker.',
  'Registering or naming a mission does not launch anything, and there is no background dispatcher that picks packets up afterwards. `cortex_launch_agent` is the only thing that launches a worker.',
  'Redo that turn now. Call `cortex_launch_agent` once per packet you described, using the same plan, then report the lane ids the tool actually returned.',
  'If you cannot launch — a tool error, a refused precondition, a missing repo — say exactly what blocked you. Do not report a dispatch you did not make.',
].join('\n');

/** The thread-visible failure when the retry does not fix it either. */
export const FALSE_DISPATCH_ERROR =
  'Dispatch failed: the orchestrator reported launching agents but made no `cortex_launch_agent` call, '
  + 'on the original turn and again after an explicit correction. Nothing was launched — no lane, no worktree, no worker '
  + 'was created, and any mission id named above is registered but empty. Re-send the request, or dispatch the packets '
  + 'directly from the mission surface.';

export interface FalseDispatchAttemptResult {
  /** True when this attempt narrated a dispatch it never made. */
  falseDispatch: boolean;
  /**
   * The `done` event the settle withheld because the attempt was a false
   * dispatch. Replayed only if the LAST attempt fails, so the client latch
   * still releases; dropped outright for a discarded attempt.
   */
  withheldDone: DoneEvent | null;
}

/**
 * Run a turn with a single, non-recursive retry on a detected false dispatch.
 *
 * Attempt isolation (#2142, the defect that killed the previous attempt): the
 * `text` / `thinking` / `tool_use` events of attempt 1 have ALREADY streamed
 * live by the time the detector fires — settle only ever gated the terminal
 * events. Without a boundary, attempt 2's narration is appended to the same chat
 * bubble and persisted that way, so the operator reads two glued-together turns.
 * The `turn_retry` event below is that boundary: ws-server drops everything
 * accumulated for the discarded attempt (in memory, on disk, and on every live
 * client) before attempt 2 emits its first token.
 */
export async function runTurnWithFalseDispatchRetry(options: {
  message: string;
  onEvent: (event: OrchestratorEvent) => void;
  runAttempt: (message: string, attempt: 1 | 2) => Promise<FalseDispatchAttemptResult>;
}): Promise<void> {
  const first = await options.runAttempt(options.message, 1);
  if (!first.falseDispatch) return;

  // Boundary FIRST — attempt 2 must not be able to emit a token into attempt 1's
  // bubble. Attempt 1's withheld `done` is dropped with the rest of its output.
  options.onEvent({
    type: 'turn_retry',
    attempt: 2,
    reason: FALSE_DISPATCH_RETRY_REASON,
    notice: FALSE_DISPATCH_RETRY_NOTICE,
  });

  const second = await options.runAttempt(FALSE_DISPATCH_CORRECTION, 2);
  if (!second.falseDispatch) return;

  // Bounded: no third attempt, no recursion. Surface it in the thread. `error`
  // then the withheld `done` mirrors the existing watchdog path so the client's
  // "Working M:SS" latch releases instead of counting to the 4-hour reaper.
  options.onEvent({ type: 'error', error: FALSE_DISPATCH_ERROR });
  if (second.withheldDone) options.onEvent(second.withheldDone);
}
