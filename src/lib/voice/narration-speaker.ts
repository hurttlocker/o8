/**
 * Fleet narration speaker — decision-to-speech mapping (#1620 — voice slice).
 *
 * Pure core (no I/O): turns the `spoken` NarrationDecision[] a narration poll
 * already approved into an ordered list of speech actions. The narration
 * policy engine (narration-policy.ts) has already decided WHAT to say and
 * WHETHER it clears budget/concurrency; this module only decides HOW to say
 * it — immediate interrupt for `interrupt-now`, queued-behind-a-pause for
 * everything else — so the host component stays a thin executor.
 */

import type { NarrationDecision } from './narration-policy';

export type NarrationSpeechMode = 'interrupt' | 'queued';

export interface NarrationSpeechAction {
  utterance: string;
  mode: NarrationSpeechMode;
  tier: NarrationDecision['tier'];
}

/**
 * Map already-approved `spoken` decisions to speech actions, in the same
 * value-per-voice-second order the policy ranked them. `interrupt-now` tier
 * speaks immediately (cuts off whatever is currently playing); every other
 * tier that reached `spoken` was already cleared to speak by the server (an
 * ambient cadence or an on-demand request was due) but still respects
 * `holdUntilPause` by queuing behind the current utterance rather than
 * cutting it off.
 */
export function planNarrationSpeech(
  decisions: readonly NarrationDecision[],
): NarrationSpeechAction[] {
  return decisions
    .filter((decision) => decision.utterance.trim().length > 0)
    .map((decision) => ({
      utterance: decision.utterance,
      mode: decision.tier === 'interrupt-now' ? 'interrupt' : 'queued',
      tier: decision.tier,
    }));
}
