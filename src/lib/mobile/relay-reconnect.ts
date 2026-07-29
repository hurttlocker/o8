/**
 * Shared jittered exponential ladder for outbound relay sockets. Attempts keep
 * returning a capped delay forever; only a successful attach resets the ladder.
 * This prevents synchronized reconnect storms without turning the cap into a
 * permanent give-up state.
 */
export class RelayReconnectPolicy {
  private attempts = 0;

  constructor(
    private readonly baseMs = 1_000,
    private readonly capMs = 30_000,
    private readonly maxExponent = 8,
    private readonly random = Math.random,
  ) {}

  reset(): void {
    this.attempts = 0;
  }

  nextDelay(): number {
    const ceiling = Math.min(this.capMs, this.baseMs * 2 ** this.attempts);
    this.attempts = Math.min(this.attempts + 1, this.maxExponent);
    const floor = Math.max(1, Math.floor(ceiling / 2));
    const sample = Math.min(1, Math.max(0, this.random()));
    return Math.min(
      ceiling,
      floor + Math.floor(sample * (ceiling - floor + 1)),
    );
  }
}
