import { describe, it, expect } from 'vitest';
import { createTerminalHostChild, type ChildPty } from './terminal-host-child';
import { createChildTerminalHost } from './terminal-host-client';
import type { TerminalHostEvent, TerminalHostRequest } from './terminal-host-protocol';

/**
 * Real-path seam coverage (repo reachability rule): the child logic is unit-
 * tested with a fake pty AND the whole seam is driven through a REAL fork of
 * terminal-host-entry.ts, round-tripping spawn → data → exit and write over the
 * actual IPC framing with a real node-pty in the child.
 */

// ── Unit: child logic with a fake pty ───────────────────────────────────────

function fakePty(): ChildPty & { emitData: (d: string) => void; emitExit: (c: number) => void; writes: string[]; killed: boolean } {
  let dataCb: ((d: string) => void) | null = null;
  let exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null;
  const writes: string[] = [];
  return {
    pid: 4242,
    onData: (cb) => { dataCb = cb; },
    onExit: (cb) => { exitCb = cb; },
    write: (d) => { writes.push(d); },
    resize: () => {},
    kill: function (this: { killed: boolean }) { this.killed = true; },
    killed: false,
    writes,
    emitData: (d) => dataCb?.(d),
    emitExit: (c) => exitCb?.({ exitCode: c }),
  };
}

describe('createTerminalHostChild (unit, fake pty)', () => {
  it('spawns, forwards data/exit, and routes write/kill by id', () => {
    const sent: TerminalHostEvent[] = [];
    const pty = fakePty();
    const child = createTerminalHostChild({ spawn: () => pty, send: (e) => sent.push(e) });

    const spawnReq: TerminalHostRequest = {
      type: 'spawn',
      id: 'a',
      spec: { file: '/bin/sh', args: [], cols: 80, rows: 24, cwd: '/tmp', env: {} },
    };
    child.handle(spawnReq);
    expect(sent).toContainEqual({ type: 'spawned', id: 'a', pid: 4242 });
    expect(child.size()).toBe(1);

    pty.emitData('hello');
    expect(sent).toContainEqual({ type: 'data', id: 'a', data: 'hello' });

    child.handle({ type: 'write', id: 'a', data: 'ls\n' });
    expect(pty.writes).toEqual(['ls\n']);

    // write/kill to an unknown id must be a no-op (not throw)
    expect(() => child.handle({ type: 'write', id: 'nope', data: 'x' })).not.toThrow();

    pty.emitExit(0);
    expect(sent).toContainEqual({ type: 'exit', id: 'a', exitCode: 0, signal: undefined });
    expect(child.size()).toBe(0);
  });

  it('reports spawn-error when the pty throws', () => {
    const sent: TerminalHostEvent[] = [];
    const child = createTerminalHostChild({
      spawn: () => { throw new Error('node-pty not available'); },
      send: (e) => sent.push(e),
    });
    child.handle({ type: 'spawn', id: 'z', spec: { file: 'x', args: [], cols: 1, rows: 1, cwd: '/', env: {} } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'spawn-error', id: 'z' });
    expect(child.size()).toBe(0);
  });
});

// ── Real fork: full IPC round-trip through terminal-host-entry.ts ────────────

describe('ChildTerminalHost (real fork over IPC)', () => {
  it('round-trips spawn → data → exit with a real node-pty child', async () => {
    const host = createChildTerminalHost();
    try {
      expect(host.mode).toBe('child');
      const handle = host.spawn({
        file: '/bin/sh',
        args: ['-c', 'printf hello-terminal-host; exit 7'],
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      });

      let buffer = '';
      const exit = await new Promise<{ exitCode: number }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no exit; buffer=${JSON.stringify(buffer)}`)), 15000);
        handle.onData((d) => { buffer += d; });
        handle.onExit((e) => { clearTimeout(timer); resolve(e); });
      });

      expect(buffer).toContain('hello-terminal-host');
      expect(exit.exitCode).toBe(7);
    } finally {
      host.dispose();
    }
  }, 20000);

  it('delivers write() to the child pty and echoes it back', async () => {
    const host = createChildTerminalHost();
    try {
      // `cat` echoes stdin back through the PTY.
      const handle = host.spawn({
        file: '/bin/cat',
        args: [],
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      });

      let buffer = '';
      const got = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no echo; buffer=${JSON.stringify(buffer)}`)), 15000);
        handle.onData((d) => {
          buffer += d;
          if (buffer.includes('ping-1498')) { clearTimeout(timer); resolve(); }
        });
      });

      // Give the fork a beat to spawn before writing.
      await new Promise((r) => setTimeout(r, 400));
      handle.write('ping-1498\n');
      await got;
      expect(buffer).toContain('ping-1498');
    } finally {
      host.dispose();
    }
  }, 20000);
});
