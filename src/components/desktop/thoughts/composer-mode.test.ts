import { describe, expect, it } from 'vitest';
import { COMPOSER_MODE_DIRECTIVES } from '@/lib/orchestrator/composer-wire';
import {
  COMPOSER_MODES,
  composeComposerModeMessage,
  composeComposerTurnMessage,
  composerModeSpec,
  resolveComposerExecutionMode,
} from './composer-mode';

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

  it('puts the Fusion directive on the wire without changing display text', () => {
    const prompt = 'Build the selector';
    const result = composeComposerModeMessage(prompt, 'fusion');
    expect(result.wireMessage).toContain('[Mode: Fusion]');
    expect(result).toEqual({
      displayMessage: prompt,
      wireMessage: `${COMPOSER_MODE_DIRECTIVES.fusion}\n\n${prompt}`,
    });
  });
});

describe('resolveComposerExecutionMode', () => {
  it('maps all four composer modes onto the shared backend literals', () => {
    expect(resolveComposerExecutionMode('solo', false)).toBe('single');
    expect(resolveComposerExecutionMode('multitask', false)).toBe('fleet');
    expect(resolveComposerExecutionMode('moa', false)).toBe('fleet');
    expect(resolveComposerExecutionMode('fusion', false)).toBe('fusion');
  });

  it('keeps the automatic single-runtime policy ahead of the selected mode', () => {
    expect(resolveComposerExecutionMode('fusion', true)).toBe('single');
  });

  it('uses one resolver for every rendered label and wire directive', () => {
    expect(COMPOSER_MODES.map((mode) => mode.id)).toEqual(['solo', 'multitask', 'moa', 'fusion']);
    for (const mode of COMPOSER_MODES) {
      const resolved = composerModeSpec(mode.id);
      const turn = composeComposerTurnMessage('Build it', mode.id, false);
      expect(resolved.label).toBe(mode.label);
      expect(turn.wireMessage).toContain(resolved.directive);
    }
  });
});
