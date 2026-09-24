import { describe, expect, it, vi } from 'vitest';
import type { RuntimeSession } from '@/lib/runtimes/types';
import { discoverDashboardCliBindings } from './dashboard-cli-bindings';

function session(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    sessionKey: 'codex:real-thread',
    runtimeId: 'codex',
    displayName: 'Codex',
    cwd: '/repo',
    status: 'running',
    ownership: 'discovered',
    pid: 4242,
    sessionCapabilities: { canSendInput: true, canInterrupt: true, canReviewDiffs: true },
    lastActivityAt: new Date('2026-09-24T12:00:00Z'),
    ...overrides,
  };
}

describe('dashboard CLI process binding', () => {
  it('binds a runtime-verified pid only to the exact o8 pane TTY', async () => {
    const command = vi.fn(async (file: string) => file === 'ps'
      ? '4242 ttys000\n'
      : 'cortex-dash-owned|/dev/ttys000\npersonal|/dev/ttys001\n');

    expect(await discoverDashboardCliBindings([session()], command)).toEqual(
      new Map([['codex:real-thread', 'cortex-dash-owned']]),
    );
    expect(command).toHaveBeenCalledTimes(2);
  });

  it('does not fabricate agents for shells, historical sessions, or unsupported runtimes', async () => {
    const command = vi.fn(async () => '');
    const bindings = await discoverDashboardCliBindings([
      session({ pid: undefined }),
      session({ sessionKey: 'codex:historical', status: 'idle' }),
      session({ sessionKey: 'gemini:live', runtimeId: 'gemini' }),
    ], command);
    expect(bindings.size).toBe(0);
    expect(command).not.toHaveBeenCalled();
  });

  it('fails closed when pane TTY identity is ambiguous or the probe fails', async () => {
    const ambiguous = async (file: string) => file === 'ps'
      ? '4242 ttys000\n'
      : 'cortex-dash-one|/dev/ttys000\ncortex-dash-two|/dev/ttys000\n';
    expect((await discoverDashboardCliBindings([session()], ambiguous)).size).toBe(0);
    expect((await discoverDashboardCliBindings([session()], async () => {
      throw new Error('tmux unavailable');
    })).size).toBe(0);
  });
});
