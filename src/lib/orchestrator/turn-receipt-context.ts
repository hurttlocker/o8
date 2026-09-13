export function withOrchestratorTurnReceiptContext(input: {
  message: string;
  threadId: string | null | undefined;
  turnId: string | null | undefined;
}): string {
  const threadId = input.threadId?.trim();
  const turnId = input.turnId?.trim();
  if (!threadId || !turnId) return input.message;

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
