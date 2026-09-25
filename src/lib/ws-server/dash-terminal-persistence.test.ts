import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  claimDashTmuxSessionForCurrentProfile,
  createDashTmuxSessionSync,
  dashSessionNameForOwnerKey,
  dashTmuxDataProfileTag,
  type DashTmuxSessionDependencies,
} from './dash-terminal-persistence';

function input(enabled = true) {
  return {
    enabled,
    sessionName: 'cortex-dash-test',
    cols: 120,
    rows: 30,
    cwd: '/tmp',
    shell: '/bin/zsh',
    env: {} as NodeJS.ProcessEnv,
  };
}

describe('dashboard terminal persistence real fallback path', () => {
  it('records the intentional plain-shell path when persistence is disabled', () => {
    const recordHealth = vi.fn();
    const resolveTmuxBinary = vi.fn(() => '/usr/bin/tmux');

    expect(createDashTmuxSessionSync(input(false), {
      resolveTmuxBinary,
      execFileSync: vi.fn(),
      recordHealth,
    })).toBe(false);
    expect(resolveTmuxBinary).not.toHaveBeenCalled();
    expect(recordHealth).toHaveBeenCalledWith('disabled', 'operator_disabled');
  });

  it('keeps the plain-shell fallback available when the health receipt cannot be written', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(createDashTmuxSessionSync(input(false), {
      resolveTmuxBinary: vi.fn(() => '/usr/bin/tmux'),
      execFileSync: vi.fn(),
      recordHealth: () => { throw new Error('read-only data directory'); },
    })).toBe(false);
  });

  it('records a redacted degraded signal when the backing runtime is absent', () => {
    const recordHealth = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(createDashTmuxSessionSync(input(), {
      resolveTmuxBinary: () => { throw new Error('sensitive lookup detail'); },
      execFileSync: vi.fn(),
      recordHealth,
    })).toBe(false);
    expect(recordHealth).toHaveBeenCalledWith('degraded', 'tmux_unavailable');
  });

  it('records creation failure before falling back to a plain shell', () => {
    const recordHealth = vi.fn();
    const exec = vi.fn()
      .mockImplementationOnce(() => { throw new Error('no existing session'); })
      .mockImplementationOnce(() => { throw new Error('create failed'); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(createDashTmuxSessionSync(input(), {
      resolveTmuxBinary: () => '/usr/bin/tmux',
      execFileSync: exec,
      recordHealth,
    })).toBe(false);
    expect(recordHealth).toHaveBeenCalledWith('degraded', 'session_create_failed');
  });

  it('reaps a partially configured backing session before falling back', () => {
    const recordHealth = vi.fn();
    const exec = vi.fn()
      .mockImplementationOnce(() => { throw new Error('no existing session'); })
      .mockReturnValueOnce(Buffer.from(''))
      .mockImplementationOnce(() => { throw new Error('option failed'); })
      .mockReturnValueOnce(Buffer.from(''));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(createDashTmuxSessionSync(input(), {
      resolveTmuxBinary: () => '/usr/bin/tmux',
      execFileSync: exec,
      recordHealth,
    })).toBe(false);
    expect(exec.mock.calls[3]?.[1]).toEqual([
      '-L', 'o8-dashboard', 'kill-session', '-t', 'cortex-dash-test',
    ]);
    expect(recordHealth).toHaveBeenCalledWith('degraded', 'session_create_failed');
  });

  it('creates dashboard sessions on the isolated tmux server with only indn disabled', () => {
    const recordHealth = vi.fn();
    const exec = vi.fn()
      .mockImplementationOnce(() => { throw new Error('no existing session'); })
      .mockReturnValueOnce(Buffer.from(''))
      .mockReturnValueOnce(Buffer.from(''))
      .mockReturnValueOnce(Buffer.from(''))
      .mockReturnValueOnce(Buffer.from(''))
      .mockReturnValueOnce(Buffer.from('xterm*:XT'))
      .mockReturnValue(Buffer.from(''));
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(createDashTmuxSessionSync(input(), {
      resolveTmuxBinary: () => '/usr/bin/tmux',
      execFileSync: exec,
      recordHealth,
    })).toBe(true);
    expect(exec.mock.calls.map((call) => call[1])).toEqual([
      ['-L', 'o8-dashboard', 'has-session', '-t', 'cortex-dash-test'],
      ['-L', 'o8-dashboard', 'new-session', '-d', '-s', 'cortex-dash-test', '-x', '120', '-y', '30', '/bin/zsh', '-l'],
      ['-L', 'o8-dashboard', 'set-option', '-t', 'cortex-dash-test', '@o8_dashboard_data_profile', dashTmuxDataProfileTag()],
      ['-L', 'o8-dashboard', 'set-option', '-t', 'cortex-dash-test', 'history-limit', '50000'],
      ['-L', 'o8-dashboard', 'set-option', '-t', 'cortex-dash-test', 'status', 'off'],
      ['-L', 'o8-dashboard', 'show-options', '-gv', 'terminal-overrides'],
      ['-L', 'o8-dashboard', 'set-option', '-ga', 'terminal-overrides', ',xterm*:indn@'],
    ]);
    expect(recordHealth).toHaveBeenCalledWith('ready', 'session_created');
  });

  it('does not grow terminal-overrides when a second dashboard session reuses the server', () => {
    const recordHealth = vi.fn();
    const exec = vi.fn()
      .mockReturnValueOnce(Buffer.from(''))
      .mockReturnValueOnce(Buffer.from(dashTmuxDataProfileTag()))
      .mockReturnValueOnce(Buffer.from('xterm*:XT,xterm*:indn@'));

    expect(createDashTmuxSessionSync(input(), {
      resolveTmuxBinary: () => '/usr/bin/tmux',
      execFileSync: exec,
      recordHealth,
    })).toBe(true);
    expect(exec.mock.calls.map((call) => call[1])).toEqual([
      ['-L', 'o8-dashboard', 'has-session', '-t', 'cortex-dash-test'],
      ['-L', 'o8-dashboard', 'show-options', '-qv', '-t', 'cortex-dash-test', '@o8_dashboard_data_profile'],
      ['-L', 'o8-dashboard', 'show-options', '-gv', 'terminal-overrides'],
    ]);
    expect(recordHealth).toHaveBeenCalledWith('ready', 'session_reused');
  });

  it('does not reuse a session marked for another data profile', () => {
    const recordHealth = vi.fn();
    const exec = vi.fn()
      .mockReturnValueOnce(Buffer.from(''))
      .mockReturnValueOnce(Buffer.from(dashTmuxDataProfileTag('/tmp/another-profile')));

    expect(createDashTmuxSessionSync(input(), {
      resolveTmuxBinary: () => '/usr/bin/tmux',
      execFileSync: exec,
      recordHealth,
    })).toBe(false);
    expect(exec.mock.calls.map((call) => call[1])).toEqual([
      ['-L', 'o8-dashboard', 'has-session', '-t', 'cortex-dash-test'],
      ['-L', 'o8-dashboard', 'show-options', '-qv', '-t', 'cortex-dash-test', '@o8_dashboard_data_profile'],
    ]);
    expect(recordHealth).toHaveBeenCalledWith('degraded', 'session_create_failed');
  });
});

describe('dashboard tmux data-profile ownership', () => {
  it('does not claim an untagged session without a saved current-profile reference', () => {
    const current = dashTmuxDataProfileTag();
    const foreign = dashTmuxDataProfileTag('/tmp/foreign-profile');
    const exec = vi.fn((_: string, args: string[]) => {
      const sessionName = args.at(-2);
      if (sessionName === 'current') return Buffer.from(current);
      if (sessionName === 'foreign') return Buffer.from(foreign);
      return Buffer.from('');
    });
    const dependencies = {
      resolveTmuxBinary: () => '/usr/bin/tmux',
      execFileSync: exec as unknown as DashTmuxSessionDependencies['execFileSync'],
    };

    expect(claimDashTmuxSessionForCurrentProfile('legacy', false, dependencies)).toBe(false);
    expect(claimDashTmuxSessionForCurrentProfile('legacy', true, dependencies)).toBe(true);
    expect(exec.mock.calls.at(-1)?.[1]).toEqual([
      '-L', 'o8-dashboard', 'set-option', '-t', 'legacy', '@o8_dashboard_data_profile', current,
    ]);
    expect(claimDashTmuxSessionForCurrentProfile('foreign', false, dependencies)).toBe(false);
  });

  it('does not claim a session when its tmux ownership read fails', () => {
    const exec = vi.fn(() => { throw new Error('tmux read failed'); });
    expect(claimDashTmuxSessionForCurrentProfile('legacy', true, {
      resolveTmuxBinary: () => '/usr/bin/tmux',
      execFileSync: exec,
    })).toBe(false);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe('dashSessionNameForOwnerKey', () => {
  it('gives one durable owner a stable private tmux identity', () => {
    const first = dashSessionNameForOwnerKey('workspace:terminal-123');
    const afterRestart = dashSessionNameForOwnerKey('workspace:terminal-123');

    expect(first).toBe(afterRestart);
    expect(first).toMatch(/^cortex-dash-[a-f0-9]{32}$/);
    expect(first).not.toContain('terminal-123');
  });

  it('keeps separate terminal owners separate', () => {
    expect(dashSessionNameForOwnerKey('workspace:terminal-a'))
      .not.toBe(dashSessionNameForOwnerKey('workspace:terminal-b'));
  });

  it('rejects missing and oversized owner keys', () => {
    expect(dashSessionNameForOwnerKey()).toBeNull();
    expect(dashSessionNameForOwnerKey('   ')).toBeNull();
    expect(dashSessionNameForOwnerKey('x'.repeat(513))).toBeNull();
  });
});

describe('dashTmuxDataProfileTag', () => {
  it('keeps a missing child stable when its parent is reached through a symlink', () => {
    const actualParent = mkdtempSync(join(tmpdir(), 'o8-profile-tag-'));
    const linkedParent = `${actualParent}-link`;
    const dataDir = join(linkedParent, 'profile');
    try {
      symlinkSync(actualParent, linkedParent);
      const beforeCreation = dashTmuxDataProfileTag(dataDir);
      mkdirSync(join(actualParent, 'profile'));
      expect(dashTmuxDataProfileTag(dataDir)).toBe(beforeCreation);
    } finally {
      rmSync(linkedParent, { force: true });
      rmSync(actualParent, { recursive: true, force: true });
    }
  });
});
