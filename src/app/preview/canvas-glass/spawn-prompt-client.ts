import { fetchCorrelatedActionReceipt } from '@/lib/orchestrator/action-receipt';

interface SpawnPromptPayload {
  ok?: unknown;
  result?: {
    ok?: unknown;
    outcomeUnknown?: unknown;
    inProgress?: unknown;
    status?: unknown;
    packetIds?: unknown;
    packets?: Array<{ id?: unknown }>;
  } | null;
}

export async function spawnCanvasAgents(input: {
  repoPath: string;
  task: string;
  count: number;
  origin?: string | null;
}) {
  const requestBody = JSON.stringify({
    ...input,
    clientMutationId: crypto.randomUUID(),
    ...(input.origin === 'symon' ? { origin: 'symon' } : {}),
  });
  const { payload } = await fetchCorrelatedActionReceipt<SpawnPromptPayload>(
    '/api/orchestrator/spawn-prompt',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: requestBody },
  );
  const result = payload?.result;
  if (payload?.ok !== true || result?.ok === false || result?.outcomeUnknown === true) {
    throw new Error('The agent spawn did not reach a confirmed launch receipt.');
  }
  const ids = Array.isArray(result?.packetIds)
    ? result.packetIds
    : Array.isArray(result?.packets)
      ? result.packets.map((packet) => packet.id)
      : [];
  return ids.filter((id): id is string => typeof id === 'string' && Boolean(id));
}
