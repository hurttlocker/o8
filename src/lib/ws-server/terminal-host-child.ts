/**
 * Child-side terminal-host logic.
 *
 * Owns a Map<id, pty> and translates parent requests into node-pty calls,
 * streaming data/exit back. Pure + injectable (spawn/send/log are passed in)
 * so it can be unit-tested with a fake pty and driven by a real fork in the
 * seam test — no node-pty import here.
 */

import type {
  PtySpawnSpec,
  TerminalHostRequest,
  TerminalHostEvent,
} from './terminal-host-protocol';

/** The minimal node-pty IPty surface the child drives. */
export interface ChildPty {
  readonly pid: number | undefined;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface TerminalHostChildDeps {
  /** Spawn a real PTY. Throws if node-pty is unavailable. */
  spawn: (spec: PtySpawnSpec) => ChildPty;
  /** Emit an event back to the parent. */
  send: (evt: TerminalHostEvent) => void;
  log?: (msg: string) => void;
}

export interface TerminalHostChild {
  handle(req: TerminalHostRequest): void;
  /** Kill every live pty (used on disconnect / shutdown). */
  killAll(): void;
  /** Live pty count — for tests/introspection. */
  size(): number;
}

export function createTerminalHostChild(deps: TerminalHostChildDeps): TerminalHostChild {
  const ptys = new Map<string, ChildPty>();
  const log = deps.log ?? (() => {});

  function handle(req: TerminalHostRequest): void {
    switch (req.type) {
      case 'spawn': {
        try {
          const p = deps.spawn(req.spec);
          ptys.set(req.id, p);
          p.onData((data) => deps.send({ type: 'data', id: req.id, data }));
          p.onExit((e) => {
            ptys.delete(req.id);
            deps.send({ type: 'exit', id: req.id, exitCode: e.exitCode, signal: e.signal });
          });
          deps.send({ type: 'spawned', id: req.id, pid: p.pid });
          log(`spawned ${req.id} (${req.spec.file}) pid=${p.pid ?? '?'}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          deps.send({ type: 'spawn-error', id: req.id, message });
          log(`spawn-error ${req.id}: ${message}`);
        }
        break;
      }
      case 'write': {
        const p = ptys.get(req.id);
        if (p) {
          try { p.write(req.data); } catch { /* pty already gone */ }
        }
        break;
      }
      case 'resize': {
        const p = ptys.get(req.id);
        if (p) {
          try { p.resize(req.cols, req.rows); } catch { /* pty already gone */ }
        }
        break;
      }
      case 'kill': {
        const p = ptys.get(req.id);
        if (p) {
          try { p.kill(req.signal); } catch { /* pty already gone */ }
        }
        break;
      }
      default: {
        // Exhaustiveness: unknown request types are ignored (forward-compat).
        break;
      }
    }
  }

  function killAll(): void {
    for (const p of ptys.values()) {
      try { p.kill(); } catch { /* already gone */ }
    }
    ptys.clear();
  }

  return { handle, killAll, size: () => ptys.size };
}
