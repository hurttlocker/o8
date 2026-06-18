/**
 * Client-side replay de-dup cursor for the orchestrator WebSocket channel.
 *
 * The server stamps every orchestrator event with a monotonic per-session
 * `seq` (see replay-buffer.ts) and replays missed events on (re)subscribe via a
 * `since` cursor. A client that opts into replay must skip any event whose seq
 * it has already applied — otherwise a replay overlap (or a re-subscribe) would
 * double-apply tokens. This is the one shared primitive every replay-aware
 * client uses (desktop, canvas, mobile).
 *
 * Events without a numeric `seq` (the subscribe-ack snapshot, notices, legacy
 * messages) always pass through and never move the cursor.
 */
export function skipDuplicateBySeq(
  msg: { seq?: unknown },
  lastSeqRef: { current: number },
): boolean {
  const seq = msg.seq;
  if (typeof seq !== 'number') return false;
  if (seq <= lastSeqRef.current) return true;
  lastSeqRef.current = seq;
  return false;
}
