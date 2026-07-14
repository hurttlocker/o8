import type { Context } from 'hono';

interface WindowEntry {
  timestamps: number[];
  lastSeen: number;
}

export class BoundedRateLimiter {
  private readonly entries = new Map<string, WindowEntry>();

  constructor(private readonly maxKeys = 20_000) {}

  allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    const prior = this.entries.get(key);
    const timestamps = (prior?.timestamps ?? []).filter((timestamp) => now - timestamp < windowMs);
    timestamps.push(now);
    this.entries.set(key, { timestamps, lastSeen: now });

    if (this.entries.size > this.maxKeys) {
      let oldestKey: string | null = null;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [candidate, entry] of this.entries) {
        if (entry.lastSeen < oldest) {
          oldest = entry.lastSeen;
          oldestKey = candidate;
        }
      }
      if (oldestKey) this.entries.delete(oldestKey);
    }

    return timestamps.length <= limit;
  }
}

/** Railway/Cloudflare overwrite these forwarding headers at the trusted edge. */
export function clientAddress(c: Context): string {
  const forwardedTail = c.req.header('x-forwarded-for')
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .at(-1);
  const address = c.req.header('cf-connecting-ip')
    || c.req.header('x-real-ip')
    || forwardedTail;
  return address?.trim().slice(0, 128) || 'unknown';
}
