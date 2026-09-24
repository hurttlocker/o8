import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ComposerContextRow } from './thoughts/chat-panel/ComposerContextRow';
import { OrchestratorEmptyState, OrchestratorStartLocationControls } from './OrchestratorEmptyState';

describe('empty workspace compose-first layout', () => {
  it('keeps the heading and leaves suggestions and start location out of the open space', () => {
    const markup = renderToStaticMarkup(createElement(OrchestratorEmptyState, {
      repoPath: '~',
      repoLabel: null,
      workspaceTargets: [],
      kind: 'orchestrator',
    }));

    expect(markup).toContain('What should we do?');
    expect(markup).not.toContain('Start with a plan');
    expect(markup).not.toContain('Review pending changes');
    expect(markup).not.toContain('What needs my attention?');
    expect(markup).not.toContain('aria-label="Start in"');
  });

  it('keeps the local/worktree choice in the composer context row', () => {
    const markup = renderToStaticMarkup(createElement(ComposerContextRow, {
      contextLocationSlot: createElement(OrchestratorStartLocationControls, {
        worktreeMode: 'local',
        onWorktreeModeChange: vi.fn(),
        branch: 'main',
        repoPath: '~',
      }),
      repoLabel: 'o8',
      workspaceTargets: [],
      selectedRepoPath: '~',
    }));

    expect(markup).toContain('data-o8-composer-context-row');
    expect(markup).toContain('aria-label="Start in"');
    expect(markup).toContain('Work locally');
    expect(markup.indexOf('Work in a project')).toBeLessThan(markup.indexOf('aria-label="Start in"'));
  });
});
