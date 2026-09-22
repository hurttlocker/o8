import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { ReviewPane } from './ReviewPane';

function packet(prOnly = false, laneId: string | undefined = 'lane'): OrchestratorPacket {
  return {
    id: 'legacy-quiz', referenceLabel: 'P1', title: 'Completed change', summary: '',
    workspaceTargetPath: null, branchTarget: 'main', runtime: 'codex',
    dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued',
    releaseState: 'pending', status: 'running',
    lane: { tileId: 'tile', tabId: 'tab', repoPath: null, runtime: 'codex',
      laneId, ...(prOnly ? { mergeMode: 'pr_only' as const } : {}) },
    explainer: { status: 'ready', changedFileCount: 10, quiz: { questions: [
      { id: 'q1', prompt: 'Legacy question', options: ['A', 'B'], answerIndex: 0 },
    ] } },
  };
}

function actionMarkup(value: OrchestratorPacket, label: string): string {
  const html = renderToStaticMarkup(createElement(ReviewPane, { packet: value }));
  expect(html).not.toContain('Legacy question');
  expect(html).not.toContain('Answer to unlock');
  return html.match(new RegExp('<button[^>]*>' + label + '</button>'))?.[0] ?? '';
}

describe('ReviewPane without comprehension quizzes', () => {
  it('keeps merge available for older reports containing quizzes', () => {
    const button = actionMarkup(packet(), 'Merge');
    expect(button).toBeTruthy();
    expect(button).not.toContain('disabled');
  });
  it('preserves the lane requirement for PR creation', () => {
    expect(actionMarkup(packet(true), 'Create PR')).not.toContain('disabled');
    const missingLane = packet(true);
    delete missingLane.lane!.laneId;
    expect(actionMarkup(missingLane, 'Create PR')).toContain('disabled');
  });
});
