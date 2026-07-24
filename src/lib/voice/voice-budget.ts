export interface VoiceBudgetSpend {
  atMs: number;
  seconds: number;
  reason?: string;
}

export interface VoiceBudgetState {
  limitSeconds: number;
  windowMs: number;
  nowMs: number;
  spends: readonly VoiceBudgetSpend[];
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function activeVoiceBudgetSpends(state: VoiceBudgetState): VoiceBudgetSpend[] {
  const windowStart = state.nowMs - finiteNonNegative(state.windowMs);
  return state.spends
    .filter((spend) => (
      Number.isFinite(spend.atMs)
      && spend.atMs > windowStart
      && spend.atMs <= state.nowMs
      && finiteNonNegative(spend.seconds) > 0
    ))
    .map((spend) => ({
      ...spend,
      seconds: finiteNonNegative(spend.seconds),
    }));
}

export function spentVoiceSeconds(state: VoiceBudgetState): number {
  return activeVoiceBudgetSpends(state)
    .reduce((total, spend) => total + spend.seconds, 0);
}

export function remainingVoiceSeconds(state: VoiceBudgetState): number {
  return Math.max(0, finiteNonNegative(state.limitSeconds) - spentVoiceSeconds(state));
}

export function voiceBudgetRemainingRatio(state: VoiceBudgetState): number {
  const limit = finiteNonNegative(state.limitSeconds);
  if (limit === 0) return 0;
  return remainingVoiceSeconds(state) / limit;
}

export function wouldExceedVoiceBudget(
  state: VoiceBudgetState,
  seconds: number,
): boolean {
  return finiteNonNegative(seconds) > remainingVoiceSeconds(state);
}

export function consumeVoiceBudget(
  state: VoiceBudgetState,
  seconds: number,
  reason?: string,
): VoiceBudgetState {
  const cost = finiteNonNegative(seconds);
  return {
    ...state,
    spends: [
      ...activeVoiceBudgetSpends(state),
      ...(cost > 0 ? [{ atMs: state.nowMs, seconds: cost, reason }] : []),
    ],
  };
}

export function valuePerVoiceSecond(valueScore: number, voiceSeconds: number): number {
  const value = finiteNonNegative(valueScore);
  const seconds = finiteNonNegative(voiceSeconds);
  return seconds === 0 ? Number.POSITIVE_INFINITY : value / seconds;
}

