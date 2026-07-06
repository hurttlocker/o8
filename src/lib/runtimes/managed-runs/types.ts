/**
 * Managed runs — the `o8 run` primitive.
 *
 * An agent (or the operator) launches a long-running process through `o8 run`,
 * which spawns it inside an o8-owned tmux session (`cortex-run-<id>`) so the
 * operator can attach a LIVE raw-stdout terminal and watch it. This registry
 * tracks those sessions so the ports surface can tag agent-owned ports and the
 * UI can offer a "watch live" chip.
 *
 * v1 is an in-process (globalThis) registry — single Next server process, no
 * cross-process (ws-server) or restart survival. Disk/SQLite persistence is a
 * deliberate later step.
 */

/** running · finished (exited, code may be known) · killed (operator stopped it) · gone (vanished, no code) */
export type ManagedRunStatus = 'running' | 'finished' | 'killed' | 'gone';

/** stream = CLI blocks + mirrors output to its own stdout; detach = fire-and-register. */
export type ManagedRunMode = 'stream' | 'detach';

export interface ManagedRunRecord {
  /** short unique id; session is `cortex-run-<id>` */
  id: string;
  /** tmux session name the bottom panel attaches to */
  session: string;
  /** the command line the agent asked to run (display only) */
  command: string;
  /** optional human display title supplied by the launcher */
  title?: string | null;
  /** working directory the command runs in (used to cross-ref lsof ports) */
  cwd: string;
  /** repo slug if known (resolved by the ports route, optional here) */
  repo?: string | null;
  /** packet id when launched from inside a packet worktree */
  packetId?: string | null;
  /** lane id when launched from inside a packet worktree */
  laneId?: string | null;
  /** tmux pane pid — the ports route attributes a port by walking the listening
   *  process's ppid chain up to this pid (o8 owns the session). */
  panePid?: number | null;
  mode: ManagedRunMode;
  startedAt: string;
  finishedAt?: string | null;
  exitCode?: number | null;
  status: ManagedRunStatus;
}
