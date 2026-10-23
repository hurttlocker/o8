import { describe, expect, it } from 'vitest';
import type { TerminalTab } from './types';
import { isCompactWorkerPane, shortWorkerTitle, workerTabLabels } from './worker-pane-chrome';

function tab(id: string, label: string, llmSummary?: string): TerminalTab {
  return { id, label, llmSummary, kind: 'orchestrator', tmuxSession: null, createdAt: 0, lastActivity: 0 };
}

describe('shortWorkerTitle', () => {
  it('prefers the packet task label and preserves its spelling', () => {
    expect(shortWorkerTitle({ label: 'Fix CI regression', branch: 'inline/117313077011567-old-task' })).toBe('Fix CI regression');
  });
  it.each([
    ['inline/117313077011567-fix-the-linux-ci-regression-on-pr-408', 'Fix the linux ci regression on pr 408'],
    ['issue/4080-repair-worker-input', 'Repair worker input'],
    ['improve-worker-tabs', 'Improve worker tabs'],
  ])('humanizes branch %s', (branch, expected) => {
    expect(shortWorkerTitle({ branch })).toBe(expected);
  });
  it('recognizes a cached raw branch label', () => {
    expect(shortWorkerTitle({ label: 'o8 • inline/123-fix-input', branch: 'inline/123-fix-input' })).toBe('Fix input');
  });
  it('has a readable empty fallback', () => {
    expect(shortWorkerTitle({ label: '  ', branch: '' })).toBe('Worker');
  });
});

describe('workerTabLabels', () => {
  it('uses the same packet label or branch fallback as the pane', () => {
    const packetTab = { ...tab('a', 'Raw'), kind: 'chat' as const, orchestrationPacket: {
      packetId: 'p', referenceLabel: '#4080', title: '', branchTarget: 'issue/4080-fix-input', status: 'running' as const, runtime: 'codex' as const,
    } };
    expect(workerTabLabels([packetTab])).toEqual(['Fix input']);
  });
  it('uses the full thread title to distinguish repeated labels', () => {
    expect(workerTabLabels([
      tab('a', 'Orchestrator', 'Repair worker input'), tab('b', 'Orchestrator', 'Review the pane frame'),
      tab('c', 'Orchestrator', 'Check compact layouts'), tab('d', 'Orchestrator', 'Verify tab labels'),
    ])).toEqual(['Repair worker input', 'Review the pane frame', 'Check compact layouts', 'Verify tab labels']);
  });
  it('never leaves a trailing colon or connector, and does not cut a title mid-phrase', () => {
    expect(workerTabLabels([tab('a', 'Build exit:'), tab('b', 'Add support for'), tab('c', 'Orchestrator', 'Add support for worker panes')]))
      .toEqual(['Build exit', 'Add support', 'Add support for worker panes']);
  });
  it('keeps custom labels and disambiguates threads with identical or missing titles', () => {
    expect(workerTabLabels([tab('a', 'Orchestrator'), tab('b', 'Orchestrator'), tab('c', 'My task')]))
      .toEqual(['Orchestrator 1', 'Orchestrator 2', 'My task']);
  });
});

describe('pane-local compact thresholds', () => {
  it.each([[479, 600, true], [900, 359, true], [480, 360, false], [700, 500, false], [280, 240, true]])(
    '%i × %i is compact: %s', (width, height, compact) => {
      expect(isCompactWorkerPane(width, height)).toBe(compact);
    },
  );
});
