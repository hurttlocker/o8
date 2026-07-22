import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DockNotchSurface } from './DockNotchSurface';

describe('DockNotchSurface confirmation review', () => {
  it('keeps a long review scrollable above fixed decision controls', () => {
    const summary = 'Review evidence. '.repeat(100);
    const markup = renderToStaticMarkup(createElement(DockNotchSurface, {
      snapshot: {
        state: 'idle',
        audioLevel: 0,
        durationMs: 0,
        error: null,
        partialTranscript: '',
      },
      agentConfirm: {
        confirmationId: 'confirm-spoken-review',
        taskId: 'confirm-spoken-review',
        tool: 'o8_approve_item',
        summary,
      },
    }));

    expect(markup).toContain('aria-label="Spoken review for confirmation"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('white-space:pre-wrap');
    expect(markup).toContain('overflow-y:auto');
    expect(markup).toContain('overscroll-behavior:contain');
    expect(markup).toContain('flex-shrink:0');
    expect(markup).toContain('Cancel');
    expect(markup).toContain('Allow');
  });
});
