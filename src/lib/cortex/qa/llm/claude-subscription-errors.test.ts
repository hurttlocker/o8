import { beforeEach, describe, expect, it, vi } from 'vitest';

const disabled = 'Your organization has disabled Claude subscription access for Claude Code.';

vi.mock('@/lib/claude-code/warm-repl-pool', () => ({
  askClaudeWarm: vi.fn(async () => disabled),
  prewarmClaudeRepl: vi.fn(),
}));
vi.mock('@/lib/operator/brain-routing', () => ({
  resolveBrainUseClaudeCliSync: vi.fn(() => true),
}));

import { callHaiku } from '@/lib/cortex/qa/llm/haiku-adapter';
import { callSonnet, resetSonnetProviderCache } from '@/lib/cortex/qa/llm/sonnet-adapter';

describe('Claude Brain adapter subscription errors', () => {
  beforeEach(() => {
    process.env.O8_CLAUDE_CODE_BIN = '/usr/bin/true';
    resetSonnetProviderCache();
  });

  it('turns ordinary disabled-subscription text into a Haiku fallback error', async () => {
    await expect(callHaiku('question')).rejects.toThrow('Claude subscription unavailable');
  });

  it('turns ordinary disabled-subscription text into a Sonnet fallback error', async () => {
    await expect(callSonnet({
      system: 'system',
      messages: [{ role: 'user', content: 'question' }],
      stream: false,
    })).rejects.toThrow('Claude subscription unavailable');
  });
});
