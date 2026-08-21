import type { OrchestratorPacket } from '@/lib/orchestrator/types';

export function PacketSpendLine({ packet }: { packet: OrchestratorPacket }) {
  const telemetry = packet.spendTelemetry;
  if (!telemetry && !packet.spendCap) return null;
  const label = telemetry?.costUsd !== null && telemetry?.costUsd !== undefined
    ? `$${telemetry.costUsd.toFixed(6)} ${telemetry.costSource}`
    : telemetry
      ? `${telemetry.inputTokens.toLocaleString()} input · cost unknown`
      : `cap $${packet.spendCap!.costUsd.toFixed(2)}`;
  return (
    <>
      <span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>·</span>
      <span style={{ fontSize: 10, color: telemetry?.capHit ? 'var(--t-danger)' : 'var(--t-text-muted)' }}>{label}</span>
    </>
  );
}
