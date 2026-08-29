import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- the benchmark client is intentionally plain JavaScript.
import { TerminalWorkloadClient } from '../scripts/bench/terminal-workload/ws-client.mjs';

describe('terminal workload server marker polling', () => {
  it('checks every pending session from one snapshot per tick', async () => {
    const client = new TerminalWorkloadClient('ws://fixture.invalid');
    const request = vi.fn()
      .mockResolvedValueOnce({
        data: {
          snapshot: {
            sessions: {
              alpha: { lastOutputTail: 'ALPHA_DONE' },
              beta: { lastOutputTail: 'still running' },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          snapshot: {
            sessions: {
              alpha: { lastOutputTail: 'tail moved on' },
              beta: { lastOutputTail: 'BETA_DONE' },
            },
          },
        },
      });
    client.request = request;

    await client.waitForServerTexts([
      { sessionName: 'alpha', marker: 'ALPHA_DONE' },
      { sessionName: 'beta', marker: 'BETA_DONE' },
    ], 1000, 0);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, 'terminal-bench-stats');
    expect(request).toHaveBeenNthCalledWith(2, 'terminal-bench-stats');
  });
});
