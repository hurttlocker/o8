process.env.O8_DASH_TMUX_SERVER_NAME = `o8-dashboard-indn-${process.pid}`;

import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createDashTmuxSessionSync,
  dashTmuxArgs,
  dashTmuxServerName,
} from '@/lib/ws-server/dash-terminal-persistence';
import { resolveTmuxBinary } from '@/lib/ws-server/pty-support';
import { renderTerminalBytes } from './helpers/headless-terminal';

const ESC = String.fromCharCode(27);
const tmuxAvailable = process.platform !== 'win32' && (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function overrides(): string {
  return String(execFileSync(resolveTmuxBinary(), dashTmuxArgs('show-options', '-gv', 'terminal-overrides'), {
    encoding: 'utf8',
    timeout: 3000,
  }));
}

afterAll(() => {
  try { execFileSync('tmux', dashTmuxArgs('kill-server'), { stdio: 'ignore', timeout: 3000 }); } catch { /* */ }
});

describe.runIf(tmuxAvailable)('isolated dashboard tmux server terminal-overrides (#1979)', () => {
  it('sets xterm*:indn@ once per server and leaves alternate-screen capability intact', () => {
    const first = createDashTmuxSessionSync({
      enabled: true,
      sessionName: 'cortex-dash-first',
      cols: 40,
      rows: 12,
      cwd: '/tmp',
      shell: '/bin/sh',
      env: process.env,
    });
    expect(first).toBe(true);
    const afterFirst = overrides();
    expect(afterFirst.split(/[\n,]/u).map((entry) => entry.trim()).filter((entry) => entry === 'xterm*:indn@'))
      .toHaveLength(1);
    expect(afterFirst).not.toContain('smcup@');
    expect(afterFirst).not.toContain('rmcup@');

    const second = createDashTmuxSessionSync({
      enabled: true,
      sessionName: 'cortex-dash-second',
      cols: 40,
      rows: 12,
      cwd: '/tmp',
      shell: '/bin/sh',
      env: process.env,
    });
    expect(second).toBe(true);
    expect(overrides()).toBe(afterFirst);

    const reused = createDashTmuxSessionSync({
      enabled: true,
      sessionName: 'cortex-dash-first',
      cols: 40,
      rows: 12,
      cwd: '/tmp',
      shell: '/bin/sh',
      env: process.env,
    });
    expect(reused).toBe(true);
    expect(overrides()).toBe(afterFirst);
    expect(dashTmuxServerName()).toBe(process.env.O8_DASH_TMUX_SERVER_NAME);

    return renderTerminalBytes([
      `PRIMARY${ESC}[?1049hALTERNATE${ESC}[?1049l`,
    ], { cols: 20, rows: 5, scrollback: 100 }).then((rows) => {
      expect(rows.join('\n')).toContain('PRIMARY');
      expect(rows.join('\n')).not.toContain('ALTERNATE');
    });
  });
});
