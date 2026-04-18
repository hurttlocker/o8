import { formatModelLabel } from '@/lib/format';
import { buildSlashCommandEntry } from './shared';
import type { ParsedOrchestratorSlashCommand, SlashCommandContext, SlashCommandExecutionResult } from './types';

const ORCHESTRATOR_CONTEXT_LIMIT = 1_000_000;

interface MissionStatusPacket {
  id?: string;
  referenceLabel?: string;
  status?: string;
  lane?: {
    runtime?: string | null;
    status?: string | null;
    lastEventLabel?: string | null;
  } | null;
}

interface MissionStatusResult {
  missionId?: string;
  summary?: string;
  prompt?: string;
  currentWave?: number;
  totalWaves?: number;
  packets?: MissionStatusPacket[];
}

function formatTokens(value: number | null) {
  if (value == null || !Number.isFinite(value)) return 'Unknown';
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return `${Math.round(value)}`;
}

function formatCost(value: number | null) {
  if (value == null || !Number.isFinite(value)) return 'Unknown';
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

async function fetchMissionStatus(missionId?: string) {
  const params = new URLSearchParams({ includeCost: 'true' });
  if (missionId?.trim()) params.set('missionId', missionId.trim());
  const response = await fetch(`/api/orchestrator/status?${params.toString()}`, {
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
  });
  if (!response.ok) return null;
  const payload = await response.json() as { ok?: boolean; result?: MissionStatusResult };
  return payload.ok ? payload.result ?? null : null;
}

export async function handleStatusSlashCommand(
  _command: ParsedOrchestratorSlashCommand,
  context: SlashCommandContext,
): Promise<SlashCommandExecutionResult> {
  const telemetry = await context.fetchTelemetry();
  const totalTokens = telemetry.totalTokens ?? context.runningTotal;
  const missionStatus = await fetchMissionStatus(context.missionState.missionId || undefined).catch(() => null);
  const packets = (missionStatus?.packets ?? context.missionState.packets)
    .filter((packet) => packet.status !== 'archived' && packet.status !== 'released')
    .slice(0, 4);
  const laneLines = packets.length > 0
    ? packets.map((packet) => {
      const laneStatus = packet.lane && 'status' in packet.lane ? packet.lane.status : null;
      const laneSummary = packet.lane
        ? [packet.lane.runtime, laneStatus, packet.lane.lastEventLabel].filter(Boolean).join(' • ')
        : 'no lane';
      return `${packet.referenceLabel ?? packet.id ?? 'packet'}: ${packet.status ?? 'unknown'} • ${laneSummary}`;
    })
    : ['No active packet or lane state is available.'];

  context.appendEntries([
    buildSlashCommandEntry({
      name: 'status',
      summary: 'Current orchestrator snapshot captured.',
      details: [
        `Mission: ${missionStatus?.summary || context.missionState.summary || missionStatus?.prompt || 'No active mission summary.'}`,
        `Wave: ${missionStatus?.currentWave ?? 0}/${missionStatus?.totalWaves ?? 0}`,
        `Tokens: ${formatTokens(totalTokens)} / ${(ORCHESTRATOR_CONTEXT_LIMIT / 1000).toFixed(0)}K`,
        `Cost: ${formatCost(telemetry.estimatedCostUsd)}`,
        `Model: ${formatModelLabel(telemetry.model ?? context.currentModel)}`,
        ...laneLines.map((line, index) => `Lane ${index + 1}: ${line}`),
      ],
      chips: [
        { label: `${Math.round(((totalTokens ?? 0) / ORCHESTRATOR_CONTEXT_LIMIT) * 100)}% context`, tone: 'blue' },
        { label: packets.length > 0 ? `${packets.length} packets` : 'idle', tone: packets.length > 0 ? 'amber' : 'emerald' },
      ],
    }),
  ]);
  return { handled: true };
}
