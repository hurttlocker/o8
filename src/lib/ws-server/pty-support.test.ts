import { afterEach, describe, expect, it, vi } from 'vitest';
import { sanitizePtyEnv } from './pty-support';
import { createChildTerminalHost } from './terminal-host-client';

/**
 * o8's terminal panel is xterm.js, whatever terminal started the server. A PTY
 * child must not inherit the server terminal's identity: with TERM_PROGRAM=tern
 * a TSP-aware program would draw for Tern, and the Tern lab's probe gate would
 * send its hello into the panel (#3734). Driven through the real forked
 * terminal host and node-pty, so the env is what the child shell actually sees.
 */
describe('sanitizePtyEnv through a real PTY', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('does not pass the server terminal identity to a PTY child', async () => {
    vi.stubEnv('TERM_PROGRAM', 'tern');
    vi.stubEnv('TERM_PROGRAM_VERSION', '0.6.2');
    const host = createChildTerminalHost();
    try {
      const handle = host.spawn({
        file: '/bin/sh',
        args: ['-c', 'printf "[%s|%s|%s]" "${TERM_PROGRAM-unset}" "${TERM_PROGRAM_VERSION-unset}" "$TERM"'],
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        env: sanitizePtyEnv(),
      });
      let buffer = '';
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no exit; buffer=${JSON.stringify(buffer)}`)), 15000);
        handle.onData((d) => { buffer += d; });
        handle.onExit(() => { clearTimeout(timer); resolve(); });
      });
      expect(buffer).toContain('[unset|unset|xterm-256color]');
    } finally {
      host.dispose();
    }
  }, 20000);
});
