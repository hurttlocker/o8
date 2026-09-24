import { describe, expect, it } from 'vitest';
import { orchestratorDisplayTitle, stableNewThreadTitle, stableOrchestratorThreadTitle, stableOrchestratorThreadTitleForId } from './thread-title';

describe('stable thread titles', () => {
  it('uses a human-readable fallback for untitled orchestrator threads', () => {
    const title = stableOrchestratorThreadTitle('2026-07-07T21:29:00.000Z');
    expect(title).toBe('Untitled conversation');
    expect(title).not.toContain('Orchestrator session');
    expect(title).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('does not derive an orchestrator title from message text or mutable save time', () => {
    const rawMessage = 'The hygiene packet is awaiting review. Review the diff properly.';
    const firstSave = stableOrchestratorThreadTitle('2026-07-07T21:29:00.000Z');
    const laterSave = stableOrchestratorThreadTitle('2026-07-08T09:10:00.000Z');
    expect(firstSave).toBe(laterSave);
    expect(firstSave).not.toContain(rawMessage);
  });

  it('keeps the id-derived fallback independent from mutable save times', () => {
    const firstSave = stableOrchestratorThreadTitleForId('thoughts-1751587200000', '2026-07-07T21:29:00.000Z');
    const laterSave = stableOrchestratorThreadTitleForId('thoughts-1751587200000', '2026-07-08T09:10:00.000Z');
    expect(firstSave).toBe(laterSave);
    expect(firstSave).toBe(stableOrchestratorThreadTitle(1751587200000));
  });

  it('replaces only the old generated timestamp title on read', () => {
    expect(orchestratorDisplayTitle('Orchestrator session · 2026-09-23 15:29', 'Untitled conversation'))
      .toBe('Untitled conversation');
    expect(orchestratorDisplayTitle('My own session title', 'Untitled conversation'))
      .toBe('My own session title');
  });

  it('keeps non-orchestrator placeholder titles compact', () => {
    expect(stableNewThreadTitle(new Date('2026-07-07T09:05:00'))).toMatch(/^New thread · \d{2}:\d{2}$/);
  });
});
