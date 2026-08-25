import { describe, expect, it } from 'vitest';
import { inferHistoricalClaudeStatus, probeLiveClaudeProcesses } from './claude-code';
import { createLiveClaudeSessionMatcher } from './claude-code-process-probe';

const NOW = Date.parse('2026-08-24T12:00:00.000Z');
const ago = (ms: number) => ({ lastModified: new Date(NOW - ms), hasErrorInTail: false });

describe('inferHistoricalClaudeStatus', () => {
  it('reports a finished turn as idle once the probe confirms no process (#1855)', () => {
    // Reached only for a session no live process owns. A successful probe makes
    // that absence the answer -- the turn is over. It used to report
    // `reviewing` for five minutes off transcript mtime alone, so a worker that
    // had already exited looked like it was still thinking.
    expect(inferHistoricalClaudeStatus(ago(10_000), true, NOW)).toBe('idle');
    expect(inferHistoricalClaudeStatus(ago(4 * 60_000), true, NOW)).toBe('idle');
  });

  it('keeps the mtime hedge when the probe could not run', () => {
    expect(inferHistoricalClaudeStatus(ago(10_000), false, NOW)).toBe('reviewing');
    expect(inferHistoricalClaudeStatus(ago(4 * 60_000), false, NOW)).toBe('reviewing');
  });

  it('falls to idle past the hedge window regardless of the probe', () => {
    expect(inferHistoricalClaudeStatus(ago(6 * 60_000), false, NOW)).toBe('idle');
    expect(inferHistoricalClaudeStatus(ago(6 * 60_000), true, NOW)).toBe('idle');
  });

  it('still surfaces a recent error tail as failed', () => {
    const errored = { lastModified: new Date(NOW - 60_000), hasErrorInTail: true };
    expect(inferHistoricalClaudeStatus(errored, true, NOW)).toBe('failed');
    expect(inferHistoricalClaudeStatus(errored, false, NOW)).toBe('failed');
  });

  it('stops calling a stale error tail failed', () => {
    const old = { lastModified: new Date(NOW - 31 * 60_000), hasErrorInTail: true };
    expect(inferHistoricalClaudeStatus(old, true, NOW)).toBe('idle');
  });
});

describe('probeLiveClaudeProcesses', () => {
  it('keeps liveness unknown when PID discovery succeeds but CWD resolution fails', async () => {
    const result = await probeLiveClaudeProcesses({
      execFile: async (file) => {
        if (file === 'bash') return { stdout: '4312 claude --model claude-opus-5\n' };
        throw new Error('lsof unavailable');
      },
    });

    expect(result).toEqual({ processes: [{ pid: 4312 }], probed: false });
    expect(inferHistoricalClaudeStatus(ago(10_000), result.probed, NOW)).toBe('reviewing');
  });

  it('binds a live process to the exact session registry identity', async () => {
    const result = await probeLiveClaudeProcesses({
      execFile: async (file) => {
        if (file === 'bash') return { stdout: '4312 claude --dangerously-skip-permissions\n' };
        return { stdout: 'p4312\nfcwd\nn/tmp/project\nf0\nn/dev/ttys004\n' };
      },
      readSessionState: async (pid) => ({
        cwd: `/tmp/project-${pid}`,
        sessionId: 'session-exact-4312',
      }),
    });

    expect(result).toEqual({
      processes: [{
        pid: 4312,
        cwd: '/tmp/project-4312',
        sessionId: 'session-exact-4312',
        tty: '/dev/ttys004',
      }],
      probed: true,
    });
  });
});

describe('createLiveClaudeSessionMatcher', () => {
  it('prefers exact session IDs and spends fallback CWD slots once', () => {
    const matches = createLiveClaudeSessionMatcher([
      { pid: 1, cwd: '/tmp/repo', sessionId: 'exact-session' },
      { pid: 2, cwd: '/tmp/repo' },
    ]);

    expect(matches('exact-session', '/tmp/repo')).toBe(true);
    expect(matches('fallback-session', '/tmp/repo')).toBe(true);
    expect(matches('extra-session', '/tmp/repo')).toBe(false);
  });
});
