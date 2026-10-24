/**
 * Per-session replay buffer for the orchestrator WebSocket channel.
 *
 * The orchestrator channel is pure fan-out (see ws-server's
 * `broadcastToOrchestratorSession`): an event sent while a client isn't
 * subscribed — or while its socket is mid-reconnect/reload — is gone forever.
 * That's why a reload mid-turn could land on a "Working" pill with no streamed
 * text: the tokens went to the dead socket and there was no backfill. This
 * buffer keeps the in-flight turn's events so a (re)subscribing client can
 * replay what it missed via a `since` cursor.
 *
 * Contract:
 * - Every broadcast event is stamped with a monotonic per-session `seq` and
 *   buffered. The client tracks the max seq it has seen and sends it as `since`
 *   on (re)subscribe; the server replays entries with seq > since.
 * - `seq` is monotonic for the life of the session (never reset), so a client
 *   cursor stays valid across turns. A session's first seq starts from the
 *   current time in milliseconds, not 0, so it also stays above a cursor a
 *   client kept from before a ws-server restart (#3665). Restarting at 0 made
 *   the client drop every new event as an already-applied replay.
 * - Both entry count and serialized UTF-8 bytes bound each retained tail.
 *   Oversized events go out live but cannot remain in replay.
 * - A new turn (`status: busy`) starts the buffer fresh. A finished turn
 *   (`status: ready | dead`, or an `error`) drops the entries so a POST-turn
 *   (re)subscribe replays nothing and relies on persisted chat history instead
 *   — replaying a completed turn would duplicate it on screen.
 */
export interface OrchestratorReplayMessage {
  channel?: string;
  event?: string;
  data?: ({ status?: string } & Record<string, unknown>);
  seq?: number;
  [key: string]: unknown;
}

interface SessionBuffer {
  seq: number;
  entries: { seq: number; raw: Buffer }[];
  bytes: number;
}

export class OrchestratorReplayBuffers {
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private readonly buffers = new Map<string, SessionBuffer>();

  constructor(maxEntries = 1500, now: () => number = Date.now, maxBytes = 4 * 1024 * 1024) {
    this.maxEntries = maxEntries;
    this.now = now;
    this.maxBytes = maxBytes;
  }

  /**
   * Stamp `msg.seq`, buffer the stamped JSON, apply turn-boundary rules, and
   * return the stamped raw string to broadcast. Mutates `msg` (adds `seq`).
   */
  record(sessionName: string, msg: OrchestratorReplayMessage): string {
    let buf = this.buffers.get(sessionName);
    if (!buf) {
      buf = { seq: Math.max(0, Math.floor(this.now())), entries: [], bytes: 0 };
      this.buffers.set(sessionName, buf);
    }

    const status = msg.event === 'status' ? msg.data?.status : undefined;
    // New turn → start the buffer fresh (seq stays monotonic).
    if (status === 'busy') {
      buf.entries = [];
      buf.bytes = 0;
    }

    buf.seq += 1;
    msg.seq = buf.seq;
    const raw = JSON.stringify(msg);
    const compact = Buffer.from(raw, 'utf8');
    buf.entries.push({ seq: buf.seq, raw: compact });
    buf.bytes += compact.length;
    while (buf.entries.length > 0 && (buf.entries.length > this.maxEntries || buf.bytes > this.maxBytes)) {
      buf.bytes -= buf.entries.shift()!.raw.length;
    }

    // Turn finished → drop the entries. Persisted chat history is the source of
    // truth for a completed turn; replaying it on a post-turn reload would
    // double it on screen.
    if (status === 'ready' || status === 'dead' || msg.event === 'error') {
      buf.entries = [];
      buf.bytes = 0;
    }
    return raw;
  }

  /**
   * Raw strings for entries with seq > since. A non-positive / non-finite
   * `since` returns the whole current buffer (a fresh client that has seen
   * nothing for this session).
   */
  since(sessionName: string, since: number): string[] {
    const buf = this.buffers.get(sessionName);
    if (!buf) return [];
    if (!Number.isFinite(since) || since <= 0) return buf.entries.map((e) => e.raw.toString('utf8'));
    return buf.entries.filter((e) => e.seq > since).map((e) => e.raw.toString('utf8'));
  }

  /** Forget a session's buffer entirely (e.g. on terminal cleanup). */
  drop(sessionName: string): void {
    this.buffers.delete(sessionName);
  }
}

/** Process-wide singleton used by ws-server. */
export const orchestratorReplay = new OrchestratorReplayBuffers(1500, Date.now, Math.max(
  1,
  Number.parseInt(process.env.O8_ORCHESTRATOR_REPLAY_BYTE_LIMIT ?? '', 10) || 4 * 1024 * 1024,
));
