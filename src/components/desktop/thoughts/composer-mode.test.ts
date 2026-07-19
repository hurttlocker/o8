import { describe, expect, it } from 'vitest';
import { composeComposerModeMessage } from './composer-mode';

describe('composeComposerModeMessage', () => {
  it('keeps the Solo directive on the wire while preserving operator text for display', () => {
    const prompt = 'Reply with exactly one word: PONG';

    expect(composeComposerModeMessage(prompt, 'solo')).toEqual({
      displayMessage: prompt,
      wireMessage: `[Mode: Solo] Work directly in this session yourself — do NOT dispatch worker agents or create missions. Edit, run, and verify with your own tools.\n\n${prompt}`,
    });
  });

  it('keeps slash commands intact for mode routing', () => {
    expect(composeComposerModeMessage('/chat Explain this diff', 'solo')).toEqual({
      displayMessage: '/chat Explain this diff',
      wireMessage: '/chat Explain this diff',
    });
  });
});
