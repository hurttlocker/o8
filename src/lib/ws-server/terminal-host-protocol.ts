/**
 * IPC protocol between ws-server (parent) and the forked terminal-host child.
 *
 * The child owns every node-pty process; the parent keeps the batch buffer,
 * scrollback, client fan-out, and tmux control. Only these small JSON frames
 * cross the process boundary (over Node's fork IPC channel). node-pty already
 * delivers/accepts PTY bytes as UTF-8 strings, so `data` is a string here —
 * faithful to what the inline path passed around.
 *
 * See docs/o8 CLAUDE.md "#1498 follow-up" — a PTY wedge in the child can no
 * longer freeze the parent's event loop (every mobile client), and vice-versa.
 */

export interface PtySpawnSpec {
  file: string;
  args: string[];
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
  /** terminal name; defaults to xterm-256color. */
  name?: string;
}

/** Parent → child. */
export type TerminalHostRequest =
  | { type: 'spawn'; id: string; spec: PtySpawnSpec }
  | { type: 'write'; id: string; data: string }
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'kill'; id: string; signal?: string };

/** Child → parent. */
export type TerminalHostEvent =
  | { type: 'spawned'; id: string; pid: number | undefined }
  | { type: 'spawn-error'; id: string; message: string }
  | { type: 'data'; id: string; data: string }
  | { type: 'exit'; id: string; exitCode: number; signal?: number };

/**
 * The subset of node-pty's IPty the terminal subsystem actually touches.
 * Both the inline adapter and the child proxy present exactly this surface.
 */
export interface TerminalHandle {
  /** May be undefined in child mode until the `spawned` frame returns. */
  readonly pid: number | undefined;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

/** A spawner for PTYs — inline (in-process) or child (forked host). */
export interface TerminalHost {
  readonly mode: 'inline' | 'child';
  spawn(spec: PtySpawnSpec): TerminalHandle;
  /** Tear down (kills the fork in child mode; no-op inline). */
  dispose(): void;
}
