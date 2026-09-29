import type { OrchestratorExecutionMode } from '@/lib/orchestrator/types';

export function withOrchestratorTurnReceiptContext(input: {
  message: string;
  threadId: string | null | undefined;
  turnId: string | null | undefined;
  /** Single mode removes the operator server, so `create_mission` does not exist (#2899). */
  orchestrationMode?: OrchestratorExecutionMode;
}): string {
  const threadId = input.threadId?.trim();
  const turnId = input.turnId?.trim();
  if (!threadId || !turnId || input.orchestrationMode === 'single') return input.message;

  return [
    '<Turn receipt context>',
    'When dispatching work with create_mission during this turn, pass both values exactly:',
    `orchestratorThreadId: "${threadId}"`,
    `orchestratorTurnId: "${turnId}"`,
    'These fields attach each successfully launched worker to this turn receipt.',
    '</Turn receipt context>',
    '',
    input.message,
  ].join('\n');
}
