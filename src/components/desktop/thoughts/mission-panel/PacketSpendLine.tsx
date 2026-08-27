import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const compactTokenCount = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

function signedCompactTokenCount(value: number) {
  return `${value > 0 ? '+' : ''}${compactTokenCount.format(value)}`;
}

export function PacketSpendLine({ packet }: { packet: OrchestratorPacket }) {
  const telemetry = packet.spendTelemetry;
  const context = packet.contextTelemetry;
  if (!telemetry && !packet.spendCap && !context) return null;
  const spendLabel = telemetry?.costUsd !== null && telemetry?.costUsd !== undefined
    ? `$${telemetry.costUsd.toFixed(6)} ${telemetry.costSource}`
    : telemetry
      ? `${telemetry.inputTokens.toLocaleString()} input · cost unknown`
      : packet.spendCap
        ? `cap $${packet.spendCap.costUsd.toFixed(2)}`
        : null;
  const contextDelta = context?.contextDeltaTokens ?? null;
  const contextLabel = context
    ? `${compactTokenCount.format(context.contextTokens)} context${contextDelta ? ` (${signedCompactTokenCount(contextDelta)})` : ''}`
    : null;
  const contextTitle = context
    ? `Latest turn: ${context.contextTokens.toLocaleString()} context tokens = ${context.cacheReadTokens.toLocaleString()} cached + ${context.inputTokens.toLocaleString()} fresh${contextDelta === null ? '.' : `. Change from prior turn: ${signedCompactTokenCount(contextDelta)} tokens.`}`
    : undefined;
  return (
    <>
      {spendLabel ? (
        <>
          <span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>·</span>
          <span style={{ fontSize: 10, color: telemetry?.capHit ? 'var(--t-danger)' : 'var(--t-text-muted)' }}>{spendLabel}</span>
        </>
      ) : null}
      {contextLabel ? (
        <>
          <span style={{ fontSize: 10, color: 'var(--t-text-muted)' }}>·</span>
          <span
            title={contextTitle}
            style={{
              fontSize: 10,
              color: contextDelta !== null && contextDelta >= 100_000
                ? 'var(--t-danger)'
                : 'var(--t-text-muted)',
            }}
          >
            {contextLabel}
          </span>
        </>
      ) : null}
    </>
  );
}
