import { describe, expect, it } from 'vitest';

import type { LaneEvent } from '@/lib/lane/types';
import { collectReviews } from './packet-receipt';

let sequence = 0;
function event(verb: LaneEvent['verb'], payload: Record<string, unknown>): LaneEvent {
  sequence += 1;
  return { id: `event-${sequence}`, laneId: 'lane-1', verb, actor: 'system', payload,
    timestamp: `2026-10-16T12:00:${String(sequence).padStart(2, '0')}.000Z` };
}

describe('packet receipt reviews (#3742)', () => {
  it('names the model the backend reported and the payer for each review turn', () => {
    const reviews = collectReviews([
      event('review_turn_started', { reviewTurnId: 'turn-or', backend: 'pi' }),
      event('update', { event: 'review_turn_runtime_receipt', reviewTurnId: 'turn-or', status: 'observed',
        runtimeRoute: { model: 'openrouter/deepseek/deepseek-v4.1-flash', effort: 'medium' } }),
      event('review_turn_finished', { reviewTurnId: 'turn-or', outcome: 'completed' }),
      event('review_turn_started', { reviewTurnId: 'turn-managed', backend: 'pi' }),
      event('update', { event: 'review_turn_runtime_receipt', reviewTurnId: 'turn-managed', status: 'observed',
        runtimeRoute: { model: 'pi', effort: 'medium' } }),
      event('review_turn_finished', { reviewTurnId: 'turn-managed', outcome: 'completed' }),
      event('review_turn_started', { reviewTurnId: 'turn-claude', backend: 'claude' }),
      event('update', { event: 'review_turn_runtime_receipt', reviewTurnId: 'turn-claude', status: 'conflicting',
        runtimeRoute: null }),
      event('review_turn_finished', { reviewTurnId: 'turn-claude', outcome: 'failed' }),
    ]);
    expect(reviews.map(({ turnId, backend, model, payer, outcome }) => ({ turnId, backend, model, payer, outcome }))).toEqual([
      { turnId: 'turn-or', backend: 'pi', model: 'openrouter/deepseek/deepseek-v4.1-flash', payer: 'openrouter', outcome: 'completed' },
      { turnId: 'turn-managed', backend: 'pi', model: 'pi', payer: 'o8-managed', outcome: 'completed' },
      // An unproven route is not guessed: the model stays null, and the payer follows the backend.
      { turnId: 'turn-claude', backend: 'claude', model: null, payer: 'anthropic-subscription', outcome: 'failed' },
    ]);
  });
});
