import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { PacketSpendLine } from './PacketSpendLine';

function packet(contextDeltaTokens: number | null): OrchestratorPacket {
  return {
    id: 'packet-context',
    referenceLabel: 'P1',
    title: 'Context receipt',
    summary: 'Show latest worker turn context.',
    workspaceTargetPath: null,
    branchTarget: 'main',
    runtime: 'claude-code',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'running',
    lane: null,
    contextTelemetry: {
      inputTokens: 203,
      cacheReadTokens: 190_448,
      contextTokens: 190_651,
      contextDeltaTokens,
      sourceEventId: 'event-context',
      observedAt: '2026-08-27T12:00:00.000Z',
    },
  };
}

describe('PacketSpendLine context receipt', () => {
  it('renders exact latest-turn context details without requiring billing telemetry', () => {
    const markup = renderToStaticMarkup(createElement(PacketSpendLine, { packet: packet(null) }));

    expect(markup).toContain('190.7K context');
    expect(markup).toContain('190,651 context tokens = 190,448 cached + 203 fresh');
  });

  it('flags a six-figure context jump on the compact packet row', () => {
    const markup = renderToStaticMarkup(createElement(PacketSpendLine, { packet: packet(150_000) }));

    expect(markup).toContain('(+150K)');
    expect(markup).toContain('var(--t-danger)');
  });
});
