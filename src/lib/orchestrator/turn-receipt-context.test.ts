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

  it('leaves threadless turns untouched', () => {
    expect(withOrchestratorTurnReceiptContext({
      message: 'No transcript owner.',
      threadId: null,
      turnId: null,
    })).toBe('No transcript owner.');
  });
});
