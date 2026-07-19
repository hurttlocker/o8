import { describe, expect, it } from 'vitest';

import { canvasQuickActionDraft, isCanvasSlashInput } from './use-canvas-quick-actions';

describe('canvas quick actions', () => {
  it('routes slash-prefixed composer input to the palette', () => {
    expect(isCanvasSlashInput('/')).toBe(true);
    expect(isCanvasSlashInput('  /canvas')).toBe(true);
    expect(isCanvasSlashInput('ask about /canvas')).toBe(false);
  });

  it('never returns a raw slash command to the canvas send path', () => {
    expect(canvasQuickActionDraft({
      id: 'clear',
      verb: 'Clear',
      label: 'Start a fresh thread',
      promptTemplate: '/clear',
    })).toBe('Start a fresh orchestrator session and clear the current thread context.');
  });
});
