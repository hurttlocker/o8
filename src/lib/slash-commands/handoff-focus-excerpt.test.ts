import { describe, expect, it, vi } from 'vitest';

import { executeOrchestratorSlashCommand } from './index';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { SlashCommandContext } from './types';

function entry(role: 'user' | 'assistant', text: string): MobileTranscriptEntry {
  return { id: text, role, type: 'message', text, timestamp: 0, timestampLabel: '12:00' };
}

function makeContext(transcript: MobileTranscriptEntry[]): SlashCommandContext {
  return {
    repoPath: '/workspace',
    transcript,
    missionState: {
      version: 2,
      prompt: '',
      summary: '',
      packets: [{
        id: 'pkt-focus',
        referenceLabel: 'P1',
        title: '',
        summary: '',
        workspaceTargetPath: '',
        branchTarget: 'main',
        runtime: 'codex',
        dependencyLabels: [],
        dependencyPacketIds: [],
        queueState: 'queued',
        releaseState: 'pending',
        status: 'running',
      }],
      updatedAt: '',
    },
    runningTotal: 0,
    currentModel: 'test-model',
    setCurrentModel: vi.fn(),
    appendEntries: vi.fn(),
    replaceTranscript: vi.fn(),
    compactNow: vi.fn().mockResolvedValue(null),
    resetRemoteSession: vi.fn().mockResolvedValue(true),
    queuePrelude: vi.fn(),
    searchArchive: vi.fn().mockResolvedValue([]),
    fetchTelemetry: vi.fn().mockResolvedValue({ totalTokens: null, estimatedCostUsd: null, model: null }),
    clearThread: vi.fn(),
  };
}

async function resumeExcerpt(command: string, context: SlashCommandContext) {
  expect(await executeOrchestratorSlashCommand(command, context)).toEqual({ handled: true });
  expect(context.queuePrelude).toHaveBeenCalledOnce();
  expect(context.queuePrelude).toHaveBeenCalledWith(expect.any(String), 'replace');
  expect(context.resetRemoteSession).toHaveBeenCalledOnce();
  const prelude = vi.mocked(context.queuePrelude).mock.calls[0][0];
  return prelude.split('\n\n')[1];
}

describe.each(['/handoff fresh session', '/focus P1'])('%s resume excerpt', (command) => {
  it('keeps the newest turn and an older long reply conclusion with a truncation marker', async () => {
    const longReply = 'FIRST_LINE P1 pkt-focus ' + 'X'.repeat(3000) + ' FINAL_LINE_OF_LONG_REPLY';
    const newestTurn = 'P1 pkt-focus newest operator instruction';
    const excerpt = await resumeExcerpt(command, makeContext([
      entry('assistant', longReply),
      entry('user', newestTurn),
    ]));

    expect(excerpt).toContain(newestTurn);
    expect(excerpt).toContain('FINAL_LINE_OF_LONG_REPLY');
    expect(excerpt).not.toContain('FIRST_LINE');
    expect(excerpt).toContain('ASSISTANT: […truncated] ');
    expect(excerpt.indexOf('FINAL_LINE_OF_LONG_REPLY')).toBeLessThan(excerpt.indexOf(newestTurn));
    expect(excerpt.length).toBeLessThanOrEqual(2600);
  });

  it('fits a truncated newest turn, including its role and marker, within the budget', async () => {
    const excerpt = await resumeExcerpt(command, makeContext([
      entry('assistant', 'FIRST_LINE P1 pkt-focus ' + 'X'.repeat(3000) + ' FINAL_LINE'),
    ]));

    expect(excerpt).toContain('ASSISTANT: […truncated] ');
    expect(excerpt).toMatch(/FINAL_LINE$/);
    expect(excerpt).not.toContain('FIRST_LINE');
    expect(excerpt.length).toBeLessThanOrEqual(2600);
  });

  it('keeps the newest matching turns when twelve turns exceed the character budget', async () => {
    const transcript = Array.from({ length: 12 }, (_, index) => (
      entry('assistant', 'P1 pkt-focus turn-marker-' + index + ' ' + 'X'.repeat(600) + ' conclusion-' + index)
    ));
    const context = makeContext(transcript);
    const excerpt = await resumeExcerpt(command, context);

    expect(excerpt).toContain('turn-marker-11');
    expect(excerpt).toContain('conclusion-11');
    expect(excerpt).not.toContain('turn-marker-0 ');
    expect(excerpt).toContain('conclusion-10');
    expect(excerpt.indexOf('conclusion-10')).toBeLessThan(excerpt.indexOf('conclusion-11'));
    expect(excerpt.length).toBeLessThanOrEqual(2600);
    if (command === '/focus P1') {
      expect(context.replaceTranscript).toHaveBeenCalledWith([...transcript, expect.any(Object)]);
    }
  });

  it('applies the eight-turn limit to the newest end even when all twelve turns fit', async () => {
    const transcript = Array.from({ length: 12 }, (_, index) => (
      entry('assistant', 'P1 pkt-focus turn-marker-' + index)
    ));
    const excerpt = await resumeExcerpt(command, makeContext(transcript));

    expect(excerpt.split('\n')).toHaveLength(8);
    expect(excerpt).toContain('turn-marker-4');
    expect(excerpt).toContain('turn-marker-11');
    expect(excerpt).not.toContain('turn-marker-3');
    expect(excerpt).not.toContain('[…truncated]');
  });

  it('preserves complete short turns in transcript order', async () => {
    const transcript = [entry('user', 'P1 pkt-focus question'), entry('assistant', 'P1 pkt-focus answer')];
    const excerpt = await resumeExcerpt(command, makeContext(transcript));

    expect(excerpt).toBe('USER: P1 pkt-focus question\nASSISTANT: P1 pkt-focus answer');
  });
});

it('/recall keeps the beginning of a search result preview', async () => {
  const context = makeContext([]);
  vi.mocked(context.searchArchive).mockResolvedValue([{
    id: 'archive-match',
    source: 'thread',
    score: 1,
    tabId: null,
    archivedAt: null,
    preview: 'search result',
    entries: [
      entry('assistant', 'MATCH_BEGINNING ' + 'X'.repeat(1000) + ' MATCH_ENDING'),
      entry('user', 'NEWEST_ARCHIVED_TURN'),
    ],
  }]);

  expect(await executeOrchestratorSlashCommand('/recall search result', context)).toEqual({ handled: true });
  expect(context.queuePrelude).toHaveBeenCalledWith(expect.any(String), 'append');
  const prelude = vi.mocked(context.queuePrelude).mock.calls[0][0];
  expect(prelude).toContain('ASSISTANT: MATCH_BEGINNING');
  expect(prelude).not.toContain('MATCH_ENDING');
  expect(prelude).not.toContain('NEWEST_ARCHIVED_TURN');
  expect(prelude).not.toContain('[…truncated]');
});
