import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DockNotchSurface } from './DockNotchSurface';
import { formatPlanProgressGlint } from './planPresentation';
import { parseConfirmationPlan } from './useAgentConfirmations';

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

  it('renders one numbered approval card for a trusted plan', () => {
    const markup = renderToStaticMarkup(createElement(DockNotchSurface, {
      snapshot: {
        state: 'idle',
        audioLevel: 0,
        durationMs: 0,
        error: null,
        partialTranscript: '',
      },
      agentConfirm: {
        confirmationId: 'confirm-plan',
        taskId: 'task-plan',
        tool: 'symon_execute_plan',
        summary: 'Create the reminder, then tell me when it is ready.',
        kind: 'plan',
        plan: {
          planId: 'plan-1',
          steps: [
            { index: 1, summary: 'Create the reminder' },
            { index: 2, summary: 'Report that the reminder is ready' },
          ],
        },
      },
    }));

    expect(markup).toContain('Symon’s plan');
    expect(markup).toContain('aria-label="Plan review for confirmation"');
    expect(markup).toContain('1.</span><span>Create the reminder');
    expect(markup).toContain('2.</span><span>Report that the reminder is ready');
    expect(markup).toContain('Run plan');
    expect(markup).not.toContain('>Allow<');
  });

  it('rejects incomplete or reordered plan confirmation metadata', () => {
    expect(parseConfirmationPlan({
      planId: 'plan-1',
      steps: [{ index: 1, summary: 'Only one step' }],
    })).toBeUndefined();
    expect(parseConfirmationPlan({
      planId: 'plan-1',
      steps: [
        { index: 2, summary: 'Second first' },
        { index: 1, summary: 'First second' },
      ],
    })).toBeUndefined();
  });
});

describe('formatPlanProgressGlint', () => {
  it('keeps every step update on one stable plan key', () => {
    const running = formatPlanProgressGlint({
      planId: 'plan-1',
      stepIndex: 2,
      stepCount: 4,
      status: 'running',
      summary: 'Creating reminder',
    });
    const completed = formatPlanProgressGlint({
      planId: 'plan-1',
      stepIndex: 2,
      stepCount: 4,
      status: 'completed',
      result: 'Reminder created',
    });

    expect(running).toEqual({
      key: 'plan:plan-1',
      text: '2 of 4 · Creating reminder',
      tone: 'progress',
    });
    expect(completed).toEqual({
      key: 'plan:plan-1',
      text: '2 of 4 · Reminder created',
      tone: 'success',
    });
  });

  it('surfaces cancelled and failed terminal states', () => {
    expect(formatPlanProgressGlint({
      planId: 'plan-2',
      stepIndex: 3,
      stepCount: 5,
      status: 'cancelled',
      summary: 'Send the message',
    })).toMatchObject({ text: '3 of 5 · Stopped · Send the message', tone: 'warning' });
    expect(formatPlanProgressGlint({
      planId: 'plan-3',
      stepIndex: 1,
      stepCount: 2,
      status: 'failure',
      result: 'Calendar unavailable',
    })).toMatchObject({ text: '1 of 2 · Failed · Calendar unavailable', tone: 'error' });
  });
});
