import { describe, expect, it, vi } from 'vitest';
import { createDashTmuxSessionSync, dashSessionNameForOwnerKey } from './dash-terminal-persistence';

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
    expect(exec.mock.calls[3]?.[1]).toEqual(['kill-session', '-t', 'cortex-dash-test']);
    expect(recordHealth).toHaveBeenCalledWith('degraded', 'session_create_failed');
  });

  it('receipts a real backing session after all required options land', () => {
    const recordHealth = vi.fn();
    const exec = vi.fn()
      .mockImplementationOnce(() => { throw new Error('no existing session'); })
      .mockReturnValue(Buffer.from(''));
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(createDashTmuxSessionSync(input(), {
      resolveTmuxBinary: () => '/usr/bin/tmux',
      execFileSync: exec,
      recordHealth,
    })).toBe(true);
    expect(exec).toHaveBeenCalledTimes(4);
    expect(recordHealth).toHaveBeenCalledWith('ready', 'session_created');
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
