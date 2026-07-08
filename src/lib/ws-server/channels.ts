/**
 * Channel backpressure semantics for the ws-server multiplexer.
 *
 * These are LOAD-BEARING and must not change: LOSSY channels (chat deltas,
 * terminal data, pong, orchestrator output) may be dropped under backpressure;
 * DURABLE channels (inbox, history, review, conflicts, lane/agent-lifecycle,
 * cortex-changes, artifacts, chat done/error) are queued and flushed. Buffer
 * limit 64KB, max 32 queued messages per client, 50ms flush interval.
 *
 * Pure classification extracted from the ws-server monolith — no shared state.
 * Faithful move; do not "improve" the fast-path matching.
 */

/** 64KB — queue durable messages once a client's socket buffer exceeds this. */
export const BACKPRESSURE_LIMIT = 64 * 1024;
/** Max queued messages per client before the oldest are dropped. */
export const BACKPRESSURE_QUEUE_LIMIT = 32;
/** Check interval (ms) to flush queued messages. */
export const BACKPRESSURE_FLUSH_MS = 50;

/**
 * Determine whether a message is "lossy" (safe to drop under backpressure)
 * or "durable" (must be queued and flushed later).
 *
 * Lossy channels: chat deltas, terminal data, pong, orchestrator output — all
 * are either inherently lossy or recovered by higher-level mechanisms.
 */
export function isLossyMessage(json: string): boolean {
  // Fast path: avoid parsing — check for known lossy patterns
  const maybeLossy =
    json.includes('"channel":"pong"') ||
    // Chat deltas (not done/error) are lossy
    (json.includes('"channel":"chat"') && json.includes('"event":"delta"')) ||
    // Terminal data frames are lossy (PTY output is best-effort)
    (json.includes('"channel":"terminal"') && json.includes('"event":"data"')) ||
    // Orchestrator output chunks are lossy (intermediate deltas can be dropped)
    (json.includes('"channel":"orchestrator"') && json.includes('"event":"output"'));
  if (!maybeLossy) return false;
  // Confirm with a real parse: payload text that merely *contains* one of the
  // marker substrings (e.g. an agent quoting protocol frames) must not cause
  // a durable message to be silently dropped. Only runs under backpressure.
  try {
    const msg = JSON.parse(json) as { channel?: unknown; event?: unknown };
    if (msg.channel === 'pong') return true;
    if (msg.channel === 'chat' && msg.event === 'delta') return true;
    if (msg.channel === 'terminal' && msg.event === 'data') return true;
    if (msg.channel === 'orchestrator' && msg.event === 'output') return true;
    return false;
  } catch {
    return false; // unparseable → treat as durable (safer)
  }
}
