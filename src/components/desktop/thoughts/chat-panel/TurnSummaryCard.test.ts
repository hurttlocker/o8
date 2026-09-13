import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { deserializeStoredTranscript, serializeTranscriptForStorage } from '@/lib/transcripts/history-serde';
import { buildTurnSummaryStats, TurnSummaryCard } from './TurnSummaryCard';

describe('TurnSummaryCard', () => {
  it('shows billable cost separately from parent context tokens', () => {
    const summary = {
        assistantMessageId: 'assistant-one',
        elapsedMs: 1_500,
        toolCount: 1,
        toolNames: ['dispatch'],
        toolNameTotal: 1,
        filesEditedCount: 0,
        filePaths: [],
        tokensUsed: 410,
        freshInputTokens: 203,
        cacheReadTokens: 40_448,
        cacheWriteTokens: 0,
        costUsd: 0.0045,
        missionFunnel: {
          totalDurationMs: 62_000,
          terminalPacketCount: 1,
          packetCount: 1,
          attemptCount: 2,
          retryCount: 1,
          interventionCount: 1,
          recoveryEventCount: 0,
          strictAutonomousCloseCount: 0,
          governedAutonomousCloseCount: 0,
        },
        repoPath: '/repo',
    };
    const html = renderToStaticMarkup(createElement(TurnSummaryCard, { summary }));

    expect(html).toContain('$0.0045');
    expect(buildTurnSummaryStats(summary).map((stat) => stat.value)).toEqual(expect.arrayContaining([
      '2 attempts · 1 retry',
      '1 interventions · 0 recoveries',
      '1/1 terminal',
      '99.5% prompt cached',
    ]));
    expect(html).not.toContain('50,000');
  });

  it('labels a reported first turn as a cold prompt without hiding its usage', () => {
    const stats = buildTurnSummaryStats({
      assistantMessageId: 'assistant-cold',
      elapsedMs: 5_000,
      toolCount: 0,
      toolNames: [],
      toolNameTotal: 0,
      filesEditedCount: 0,
      filePaths: [],
      tokensUsed: 40_635,
      freshInputTokens: 40_624,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      repoPath: '/repo',
    });
    expect(stats).toContainEqual({ key: 'cache', value: 'cold prompt' });
  });

  it('renders effective receipt labels and workers from a persisted entry after reload', () => {
    const [persistedEntry] = deserializeStoredTranscript(serializeTranscriptForStorage([{
      id: 'assistant-receipt',
      role: 'assistant',
      text: 'Complete.',
      receipt: {
        leadModel: 'gpt-6-astra',
        effort: 'xhigh',
        mode: 'fusion',
        pickedMode: 'solo',
        workers: [{ packetId: 'packet-1', runtime: 'codex', model: 'gpt-5.6-terra' }],
      },
    }]));
    const html = renderToStaticMarkup(createElement(TurnSummaryCard, { persistedEntry }));

    expect(html).toContain('GPT-6 Astra');
    expect(html).toContain('extra');
    expect(html).toContain('ran as Fusion, picked Solo');
    expect(html).toContain('Codex · GPT-5.6 Terra');
  });

  it('renders no receipt line and does not crash for a legacy persisted entry', () => {
    const [persistedEntry] = deserializeStoredTranscript(serializeTranscriptForStorage([{
      id: 'assistant-legacy',
      role: 'assistant',
      text: 'Legacy turn.',
    }]));

    expect(renderToStaticMarkup(createElement(TurnSummaryCard, { persistedEntry }))).toBe('');
  });
});
