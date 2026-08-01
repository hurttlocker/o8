import { describe, expect, it, vi } from 'vitest';
import { handleCodexJsonLine } from './codex-orchestrator-events';

describe('Codex orchestrator error events', () => {
  it('emits the real turn.failed quota message from the CLI JSON stream', () => {
    const onEvent = vi.fn();
    const parsed = handleCodexJsonLine(JSON.stringify({
      type: 'turn.failed',
      error: {
        code: 'usage_limit_reached',
        message: 'You have hit your usage limit. Try again when it resets.',
      },
    }), { threadId: null, cost: null }, onEvent, { isLocalModel: false });

    expect(parsed).toBe(true);
    expect(onEvent).toHaveBeenCalledWith({
      type: 'error',
      error: 'You have hit your usage limit. Try again when it resets.',
      code: 'usage_limit_reached',
    });
  });
});
