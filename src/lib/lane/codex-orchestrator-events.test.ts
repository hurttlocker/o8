import { describe, expect, it, vi } from 'vitest';
import { handleCodexJsonLine, type CodexLineHandlerState } from './codex-orchestrator-events';

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

  it('retains fresh, cached, and output token truth from a completed turn', () => {
    const state: CodexLineHandlerState = { threadId: null, cost: null };

    handleCodexJsonLine(JSON.stringify({
      type: 'turn.completed',
      usage: {
        input_tokens: 40_651,
        cached_input_tokens: 40_448,
        output_tokens: 11,
      },
    }), state, vi.fn(), { isLocalModel: false });

    expect(state).toMatchObject({
      usage: {
        inputTokens: 203,
        outputTokens: 11,
        cacheReadTokens: 40_448,
        cacheWriteTokens: 0,
      },
    });
  });
});
