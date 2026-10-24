// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentPanelChatInjectionPayload } from '@/lib/chat/injection';
import { PRChecksSection } from './PRChecksSection';
import type { PRDetail } from './types';

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
type Check = PRDetail['statusCheckRollup'][number];

function detail(checks: Check[]): PRDetail {
  return {
    number: 7, title: 'Fixture checks', body: '', state: 'OPEN',
    author: { login: 'fixture-owner' }, headRefName: 'fixture-branch', baseRefName: 'main',
    additions: 0, deletions: 0, changedFiles: 0, createdAt: '2026-01-01T00:00:00Z',
    mergedAt: null, closedAt: null, mergedBy: null, labels: [], reviews: [], files: [],
    statusCheckRollup: checks, reviewComments: [], issueComments: [], diffStat: '',
    url: 'https://github.com/example/fixture/pull/7',
  };
}

describe('failed-check batch evidence from the rendered PR checks section', () => {
  let root: Root;
  let container: HTMLDivElement;
  let deliveries: Array<{ key: string; payload: AgentPanelChatInjectionPayload }>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    deliveries = [];
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(checks: Check[], addedContextKeys: Record<string, true> = {}) {
    await act(async () => root.render(createElement(PRChecksSection, {
      pr: detail(checks), activeItemIndex: -1, addedContextKeys,
      checkContextKey: (name) => `check:${name}`,
      injectPayload: (key, payload) => { deliveries.push({ key, payload }); },
      onInjectChatContext: () => {}, repo: 'example/fixture',
    })));
  }

  function batchButton(label = 'Add all failed checks') {
    return [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === label);
  }

  it('offers the repair journey through the live checks section only for failures', async () => {
    await render([{ name: 'Tests', status: 'completed', conclusion: 'failure' }]);
    expect(batchButton('Fix failing checks')).toBeDefined();
    await render([{ name: 'Tests', status: 'completed', conclusion: 'neutral' }]);
    expect(batchButton('Fix failing checks')).toBeUndefined();
  });

  it.each([
    ['SUCCESS', 'COMPLETED', 'passed', '\u2713'],
    ['', 'in_progress', 'pending', '\u25CB'],
    ['', 'queued', 'pending', '\u25CB'],
    ['FAILURE', 'COMPLETED', 'failed', '\u2717'],
    ['timed_out', 'completed', 'failed', '\u2717'],
    ['ACTION_REQUIRED', 'COMPLETED', 'failed', '\u2717'],
    ['startup_failure', 'completed', 'failed', '\u2717'],
    ['NEUTRAL', 'COMPLETED', 'neutral', '\u2014'],
    ['neutral', 'completed', 'neutral', '\u2014'],
    ['SKIPPED', 'COMPLETED', 'skipped', '\u2014'],
    ['cancelled', 'completed', 'skipped', '\u2014'],
    ['STALE', 'COMPLETED', 'neutral', '\u2014'],
  ])('shows %s/%s as %s rather than inventing a failure', async (conclusion, status, outcome, glyph) => {
    await render([{ name: 'Fixture status', status, conclusion }]);
    expect(container.querySelector('[data-pr-section="checks"]')?.firstElementChild?.textContent).toBe(glyph);
    const indicator = container.querySelector(`[role="img"][aria-label="Check ${outcome}"]`);
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toBe(glyph);
    if (outcome !== 'failed') expect(container.textContent).not.toContain('\u2717');
  });

  it.each(['NEUTRAL', 'neutral', 'SKIPPED', 'CANCELLED', 'SUCCESS', '', 'STALE'])(
    'does not offer failed-check batch evidence for a non-failure (%s)', async (conclusion) => {
      await render([{ name: 'Non-failing check', status: conclusion ? 'COMPLETED' : 'IN_PROGRESS', conclusion }]);
      expect(batchButton()).toBeUndefined();
      expect(deliveries).toEqual([]);
    },
  );

  it('injects only canonical failures from a mixed batch with their check URLs', async () => {
    const failures = ['FAILURE', 'timed_out', 'ACTION_REQUIRED', 'startup_failure'].map((conclusion, index) => ({
      name: `Repair ${index}`, status: 'COMPLETED', conclusion,
      detailsUrl: `https://github.com/example/fixture/actions/runs/${index + 1}`,
    }));
    const nonFailures = ['SUCCESS', 'NEUTRAL', 'SKIPPED', 'CANCELLED', '', 'STALE'].map((conclusion, index) => ({
      name: `Keep ${index}`, status: conclusion ? 'COMPLETED' : 'QUEUED', conclusion,
      detailsUrl: `https://github.com/example/fixture/actions/runs/${index + 20}`,
    }));
    await render([...failures, ...nonFailures]);
    expect(batchButton()).toBeDefined();
    await act(async () => batchButton()!.click());
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].key).toBe('checks-all:7');
    expect(deliveries[0].payload.reason).toBe('ci-check-batch-7');
    for (const check of failures) {
      expect(deliveries[0].payload.text).toContain(check.name);
      expect(deliveries[0].payload.text).toContain(check.detailsUrl);
    }
    for (const check of nonFailures) expect(deliveries[0].payload.text).not.toContain(check.name);
  });

  it('keeps an already-added failure batch disabled', async () => {
    await render([{ name: 'Failure', status: 'COMPLETED', conclusion: 'FAILURE' }], { 'checks-all:7': true });
    expect(batchButton('Added to chat')?.disabled).toBe(true);
    await act(async () => batchButton('Added to chat')!.click());
    expect(deliveries).toEqual([]);
  });
});
