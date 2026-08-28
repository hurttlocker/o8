import { recordLaneEvent } from '@/lib/lane/events';
import { getLaneEvents } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import { parsePacketTaskContract } from '@/lib/orchestrator/packet-task-contract';
import type { PacketTaskContract } from '@/lib/orchestrator/types';
import type { RuntimeId, RuntimeTelemetry, RuntimeTranscriptEntry } from '@/lib/runtimes/types';

export interface PacketTaskContractCapture {
  contract: PacketTaskContract;
  entryIndex: number;
}

export function findFirstTaskContractCapture(
  entries: RuntimeTranscriptEntry[],
): PacketTaskContractCapture | null {
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex];
    if (entry?.role !== 'assistant' || !entry.text.trim()) continue;
    const contract = parsePacketTaskContract(entry.text);
    if (contract) return { contract, entryIndex };
  }
  return null;
}

function eventDurationMs(entries: RuntimeTranscriptEntry[], entryIndex: number): number {
  const contractAt = entries[entryIndex]?.timestamp.getTime() ?? Number.NaN;
  const turnStart = entries
    .slice(0, entryIndex + 1)
    .findLast((entry) => entry.role === 'user')
    ?? entries[0];
  const startedAt = turnStart?.timestamp.getTime() ?? Number.NaN;
  return Number.isFinite(contractAt) && Number.isFinite(startedAt)
    ? Math.max(0, Math.round(contractAt - startedAt))
    : 0;
}

function attributableTelemetry(
  entries: RuntimeTranscriptEntry[],
  capture: PacketTaskContractCapture,
  telemetry?: RuntimeTelemetry,
): Pick<RuntimeTelemetry, 'inputTokens' | 'outputTokens'> {
  const assistantTurns = entries
    .slice(0, capture.entryIndex + 1)
    .filter((entry) => entry.role === 'assistant' && entry.text.trim()).length;
  const hasLaterContent = entries
    .slice(capture.entryIndex + 1)
    .some((entry) => entry.text.trim() || entry.toolCalls?.length);
  if (assistantTurns !== 1 || hasLaterContent) return {};

  return {
    ...(typeof telemetry?.inputTokens === 'number' && Number.isFinite(telemetry.inputTokens)
      ? { inputTokens: telemetry.inputTokens }
      : {}),
    ...(typeof telemetry?.outputTokens === 'number' && Number.isFinite(telemetry.outputTokens)
      ? { outputTokens: telemetry.outputTokens }
      : {}),
  };
}

export function recordTaskContractCostEvent(input: {
  lane: Lane | null;
  runtime: RuntimeId | null;
  transcript: RuntimeTranscriptEntry[];
  capture: PacketTaskContractCapture | null;
  telemetry?: RuntimeTelemetry;
}): void {
  if (!input.lane || !input.capture) return;
  if (getLaneEvents(input.lane.id, 10_000).some((event) => event.verb === 'task_contract_cost')) return;

  const turns = input.transcript
    .slice(0, input.capture.entryIndex + 1)
    .filter((entry) => entry.role === 'assistant' && entry.text.trim()).length;
  recordLaneEvent(input.lane.id, 'task_contract_cost', 'system', {
    runtime: input.runtime ?? input.lane.runtime,
    turns: Math.max(1, turns),
    ...attributableTelemetry(input.transcript, input.capture, input.telemetry),
    durationMs: eventDurationMs(input.transcript, input.capture.entryIndex),
  });
}
