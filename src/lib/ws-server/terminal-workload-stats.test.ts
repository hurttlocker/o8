import { describe, expect, it } from 'vitest';
import { TerminalWorkloadStats } from './terminal-workload-stats';

describe('terminal workload snapshot cost and correctness', () => {
  it('reads current bounded output without inspecting any retained scrollback', () => {
    const stats = new TerminalWorkloadStats();
    stats.recordPty('alpha', 'ALPHA_DONE', 123);
    stats.recordPty('beta', 'BETA_READY', 124);
    const attachments = [{ sessionName: 'alpha', get scrollbackChunks(): string[] {
      throw new Error('output polling must not walk retained scrollback');
    } }];
    expect(stats.capture(attachments, true)).toEqual({
      schema: 'o8/terminal-output-tails/v1',
      sessions: {
        alpha: { lastOutputTail: 'ALPHA_DONE', lastOutputAt: 123 },
        beta: { lastOutputTail: 'BETA_READY', lastOutputAt: 124 },
      },
    });
  });

  it('keeps full snapshots authoritative after lightweight polling', () => {
    const stats = new TerminalWorkloadStats();
    const attachment = { sessionName: 'alpha', scrollbackChunks: ['\x1b[?10', '49h', 'content'] };
    stats.recordPty('alpha', '\x1b[?1049hcontent');
    stats.capture([attachment], true);
    const full = stats.capture([attachment]);
    expect(full.schema).toBe('o8/terminal-server-stats/v1');
    if (full.schema !== 'o8/terminal-server-stats/v1') throw new Error('missing full snapshot');
    expect(full.sessions.alpha.alternateScreen).toEqual({
      observedEnter: true, observedExit: false, retainedEnter: true, retainedExit: false,
    });
    // Retention can evict the enter sequence while preserving a later exit.
    attachment.scrollbackChunks = ['content\x1b[?1049l'];
    stats.recordPty('alpha', '\x1b[?1049l');
    stats.capture([attachment], true);
    const updated = stats.capture([attachment]);
    if (updated.schema !== 'o8/terminal-server-stats/v1') throw new Error('missing full snapshot');
    expect(updated.sessions.alpha.alternateScreen).toEqual({
      observedEnter: true, observedExit: true, retainedEnter: false, retainedExit: true,
    });
  });

  it('keeps output tails bounded and does not expose mutable state', () => {
    const stats = new TerminalWorkloadStats();
    stats.recordPty('alpha', 'x'.repeat(10_000));
    const first = stats.capture([], true);
    expect(first.sessions.alpha.lastOutputTail.length).toBe(4096);
    first.sessions.alpha.lastOutputTail = 'changed by consumer';
    expect(stats.capture([], true).sessions.alpha.lastOutputTail).toBe('x'.repeat(4096));
  });
});
