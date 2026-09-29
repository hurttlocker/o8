import { describe, expect, it } from 'vitest';
import { withOrchestratorTurnReceiptContext } from './turn-receipt-context';

describe('orchestrator turn receipt context', () => {
  it('teaches create_mission the exact persisted thread and turn ids', () => {
    const message = withOrchestratorTurnReceiptContext({
      message: 'Dispatch the task.',
      threadId: 'thoughts-123',
      turnId: 'assistant-456',
    });

    expect(message).toContain('orchestratorThreadId: "thoughts-123"');
    expect(message).toContain('orchestratorTurnId: "assistant-456"');
    expect(message).toContain('Dispatch the task.');
  });

  it('omits the create_mission receipt on a single-mode turn', () => {
    expect(withOrchestratorTurnReceiptContext({
      message: 'Work directly.',
      threadId: 'thoughts-123',
      turnId: 'assistant-456',
      orchestrationMode: 'single',
    })).toBe('Work directly.');
  });

  it('keeps the receipt on fleet and fusion turns', () => {
    for (const orchestrationMode of ['fleet', 'fusion'] as const) {
      expect(withOrchestratorTurnReceiptContext({
        message: 'Dispatch the task.',
        threadId: 'thoughts-123',
        turnId: 'assistant-456',
        orchestrationMode,
      }), orchestrationMode).toContain('orchestratorTurnId: "assistant-456"');
    }
  });

  it('leaves threadless turns untouched', () => {
    expect(withOrchestratorTurnReceiptContext({
      message: 'No transcript owner.',
      threadId: null,
      turnId: null,
    })).toBe('No transcript owner.');
  });
});
