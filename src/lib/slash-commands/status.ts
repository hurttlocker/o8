import { formatModelLabel } from '@/lib/format';
import { buildSlashCommandEntry, collectRecentDecisionLines } from './shared';
import type { ParsedOrchestratorSlashCommand, SlashCommandContext, SlashCommandExecutionResult } from './types';

const ORCHESTRATOR_CONTEXT_LIMIT = 1_000_000;

function formatTokens(value: number | null) {
  if (value == null || !Number.isFinite(value)) return 'Unknown';
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return `${Math.round(value)}`;
}

function formatCost(value: number | null) {
  if (value == null || !Number.isFinite(value)) return 'Unknown';
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

export async function handleStatusSlashCommand(
  _command: ParsedOrchestratorSlashCommand,
  context: SlashCommandContext,
): Promise<SlashCommandExecutionResult> {
  const telemetry = await context.fetchTelemetry();
  const totalTokens = telemetry.totalTokens ?? context.runningTotal;
  const activePackets = context.missionState.packets.filter((packet) => (
    packet.status === 'launching'
    || packet.status === 'running'
    || packet.status === 'awaiting_review'
    || packet.status === 'recovering'
  ));
  const recentDecisions = collectRecentDecisionLines(context.transcript, 3);
  const decisions = recentDecisions.length > 0
    ? recentDecisions
    : ['No recent assistant decisions are visible in this thread yet.'];

  context.appendEntries([
    buildSlashCommandEntry({
      name: 'status',
      summary: 'Current orchestrator snapshot captured.',
      details: [
        `Tokens: ${formatTokens(totalTokens)} / ${(ORCHESTRATOR_CONTEXT_LIMIT / 1000).toFixed(0)}K`,
        `Cost: ${formatCost(telemetry.estimatedCostUsd)}`,
        `Model: ${formatModelLabel(telemetry.model ?? context.currentModel)}`,
        `Active dispatches: ${activePackets.length > 0 ? activePackets.map((packet) => packet.referenceLabel).join(', ') : 'None'}`,
        ...decisions.map((decision, index) => `Decision ${index + 1}: ${decision}`),
      ],
      chips: [
        { label: `${Math.round(((totalTokens ?? 0) / ORCHESTRATOR_CONTEXT_LIMIT) * 100)}% context`, tone: 'blue' },
        { label: activePackets.length > 0 ? `${activePackets.length} active` : 'idle', tone: activePackets.length > 0 ? 'amber' : 'emerald' },
      ],
    }),
  ]);
  return { handled: true };
}
