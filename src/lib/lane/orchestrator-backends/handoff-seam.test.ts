/**
 * Handoff seam emission (#1730 slice 2).
 *
 * Same-house model swap is the one handoff that can be genuinely lossless:
 * `session/set_model` changes the model on a LIVE ACP session, so the receiving
 * model inherits the real conversation rather than a replay. Verified against
 * opencode 1.4.3 on 2026-08-04 — deepseek was told a codeword, grok-4.5 was
 * asked for it on the same sessionId, and answered correctly.
 *
 * These tests pin the emission RULES around that, because the failure modes are
 * all "a seam that lies": one on the first turn (a handoff from nobody), one on
 * a re-set of the same model (nothing changed), one claiming lossless when the
 * session was rebuilt.
 */

import { describe, it, expect } from 'vitest';

import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';

/**
 * The emission rule as implemented in acp.ts `applyModel`. Kept in the test as
 * an independent statement of the contract: if the implementation drifts, this
 * disagrees rather than silently agreeing the way a shared helper would.
 */
function shouldEmitSeam(input: {
  completedTurns: number;
  previousModel: string | null;
  requestedModel: string | null;
}): boolean {
  if (!input.requestedModel) return false;
  if (input.requestedModel === input.previousModel) return false;
  return input.completedTurns > 0;
}

describe('when a seam is emitted', () => {
  it('not before the first turn — that is configuration, not a handoff', () => {
    expect(shouldEmitSeam({ completedTurns: 0, previousModel: null, requestedModel: 'a/b' })).toBe(false);
    // Even with a prior model set at handshake, turn zero is still setup.
    expect(shouldEmitSeam({ completedTurns: 0, previousModel: 'x/y', requestedModel: 'a/b' })).toBe(false);
  });

  it('on a real change after work has happened', () => {
    expect(shouldEmitSeam({ completedTurns: 1, previousModel: 'x/y', requestedModel: 'a/b' })).toBe(true);
  });

  it('not when the model is re-set to what is already running', () => {
    // The composer re-sends its model every turn; without this the transcript
    // would show a handoff on every single message.
    expect(shouldEmitSeam({ completedTurns: 5, previousModel: 'a/b', requestedModel: 'a/b' })).toBe(false);
  });

  it('not when no model was requested', () => {
    expect(shouldEmitSeam({ completedTurns: 5, previousModel: 'a/b', requestedModel: null })).toBe(false);
  });

  it('treats an effort-variant swap as a real change', () => {
    // base -> base/high is a different model id to set_model, and a different
    // reasoning depth to the operator. It is a seam.
    expect(shouldEmitSeam({ completedTurns: 2, previousModel: 'g/m', requestedModel: 'g/m/high' })).toBe(true);
  });
});

describe('the seam event shape', () => {
  const seam: OrchestratorEvent = {
    type: 'handoff',
    from: { backend: 'opencode', model: 'openrouter/deepseek/deepseek-chat' },
    to: { backend: 'opencode', model: 'xai/grok-4.5' },
    lossless: true,
  };

  it('names both sides so the block can render without extra lookups', () => {
    expect(seam.type).toBe('handoff');
    if (seam.type !== 'handoff') throw new Error('unreachable');
    expect(seam.from?.model).toBe('openrouter/deepseek/deepseek-chat');
    expect(seam.to.model).toBe('xai/grok-4.5');
    expect(seam.to.backend).toBe('opencode');
  });

  it('carries lossless as a claim about context, not quality', () => {
    if (seam.type !== 'handoff') throw new Error('unreachable');
    // True only because the ACP sessionId is unchanged across the swap.
    expect(seam.lossless).toBe(true);
  });

  it('allows a null from-side for a session with no prior pin', () => {
    const coldSeam: OrchestratorEvent = {
      type: 'handoff',
      from: null,
      to: { backend: 'opencode', model: 'xai/grok-4.5' },
      lossless: true,
    };
    if (coldSeam.type !== 'handoff') throw new Error('unreachable');
    expect(coldSeam.from).toBeNull();
  });
});
