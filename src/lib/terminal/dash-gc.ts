/**
 * #6 persistent terminals — orphan-session GC policy (pure).
 *
 * Under `O8_PERSISTENT_TERMINALS`, interactive dash terminals live in detached
 * tmux sessions that survive a ws-server restart / app crash. The flip side of
 * survival is a leak: a session whose tab was closed (or whose app crashed
 * before the tab was cleaned up) has no owner and would live forever. This
 * module is the bounded reaper that decides which `cortex-dash-*` tmux sessions
 * are safe to kill.
 *
 * Kept pure (no tmux / fs side effects) so the policy is unit-testable; the
 * ws-server side does the `tmux list-sessions` / `kill-session` I/O and the
 * reference gathering, then asks this function what to kill.
 *
 * The reference set MUST be sourced from the DURABLE identity (persisted tabs +
 * sessions with live clients), never the in-memory attachment map alone — after
 * a crash that map is empty, and keying on it would reap every survivor.
 */

export interface DashSessionInfo {
  /** tmux session name, e.g. `cortex-dash-1a2b3c4d`. */
  name: string;
  /** tmux `#{session_created}` in ms (0 if unknown — treated as old). */
  createdMs: number;
}

export interface DashGcOptions {
  nowMs: number;
  /** Don't reap a session younger than this (guards the create→persist race). */
  minAgeMs: number;
  /** Hard cap on surviving `cortex-dash-*` sessions, ignoring min-age for overflow. */
  maxSessions: number;
}

/**
 * Given the live `cortex-dash-*` sessions and the set of referenced names,
 * return the names safe to kill.
 *
 * - A session is an orphan when it is unreferenced AND older than `minAgeMs`.
 * - If, after removing orphans, the surviving count still exceeds `maxSessions`,
 *   reap the oldest *unreferenced* sessions beyond the cap (ignoring min-age) —
 *   a referenced session is NEVER killed, even when over cap.
 */
export function selectOrphanDashSessions(
  sessions: DashSessionInfo[],
  referenced: Set<string>,
  opts: DashGcOptions,
): string[] {
  const toKill = new Set<string>();

  for (const session of sessions) {
    if (referenced.has(session.name)) continue;
    if (opts.nowMs - session.createdMs < opts.minAgeMs) continue;
    toKill.add(session.name);
  }

  const survivorsAfter = sessions.length - toKill.size;
  if (survivorsAfter > opts.maxSessions) {
    const overflow = sessions
      .filter((session) => !toKill.has(session.name) && !referenced.has(session.name))
      .sort((a, b) => a.createdMs - b.createdMs);
    let over = survivorsAfter - opts.maxSessions;
    for (const session of overflow) {
      if (over <= 0) break;
      toKill.add(session.name);
      over -= 1;
    }
  }

  return [...toKill];
}
