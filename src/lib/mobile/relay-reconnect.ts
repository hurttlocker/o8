/**
 * Shared capped exponential backoff for outbound relay sockets. The mobile and
 * machine attach lanes own different authentication handshakes, but use the
 * same retry policy so a relay outage cannot create parallel reconnect storms.
 */
export class RelayReconnectPolicy {
  private attempts = 0;

  constructor(
    private readonly baseMs = 1_000,
    private readonly capMs = 30_000,
    private readonly maxExponent = 8,
  ) {}

  reset(): void {
    this.attempts = 0;
  }

  nextDelay(): number {
    const delay = Math.min(this.capMs, this.baseMs * 2 ** this.attempts);
    this.attempts = Math.min(this.attempts + 1, this.maxExponent);
    return delay;
  }
}
