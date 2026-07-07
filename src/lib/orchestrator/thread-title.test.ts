import { describe, expect, it } from 'vitest';
import { stableNewThreadTitle, stableOrchestratorThreadTitle, stableOrchestratorThreadTitleForId } from './thread-title';

describe('stable thread titles', () => {
  it('uses a stable timestamp label for untitled orchestrator threads', () => {
    expect(stableOrchestratorThreadTitle('2026-07-07T21:29:00.000Z')).toContain('2026-07-07');
  });

  it('does not derive an orchestrator title from message text', () => {
    const rawMessage = 'The hygiene packet is awaiting review. Review the diff properly.';
    expect(stableOrchestratorThreadTitle('2026-07-07T21:29:00.000Z')).not.toContain(rawMessage);
  });

  it('derives orchestrator fallback titles from immutable thread ids before mutable save times', () => {
    expect(stableOrchestratorThreadTitleForId('thoughts-1751587200000', '2026-07-07T21:29:00.000Z')).toBe(
      stableOrchestratorThreadTitle(1751587200000),
    );
  });

  it('keeps non-orchestrator placeholder titles compact', () => {
    expect(stableNewThreadTitle(new Date('2026-07-07T09:05:00'))).toMatch(/^New thread · \d{2}:\d{2}$/);
  });
});
