import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ApprovalRecord, ApprovalReferee } from '@/lib/approvals/types';
import { DIFF_QUESTIONS } from '@/lib/judgment/questions';
import { O8ApprovalCards } from './O8ApprovalCards';

const legend = Object.fromEntries(DIFF_QUESTIONS.risk.criteria.map((text, index) => [String(index), text]));

const referee: ApprovalReferee = {
  receiptId: 'jdg_card',
  model: 'jev-1.13.0',
  answers: {
    docsOnly: { noul: 0.03 },
    addsTests: { noul: 0.12 },
    touchesMiddlewareOrAuth: { noul: 0.91 },
    containsPlaceholderOrMockData: { noul: 0.07 },
    risk: { score: 3.1, legend, probabilities: { 3: 0.64 }, confidence: 0.88, abstain: false },
  },
  truncated: true,
  hiddenText: false,
  filesAddedFromDiff: 2,
  pathTouchesMiddlewareOrAuth: true,
  diffFingerprint: 'fp-card',
  askedAt: 1,
};

function approval(extra: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: 'approval-card',
    projectId: null,
    source: 'runtime',
    runtime: 'codex',
    agent: 'worker',
    sessionKey: 'codex:pkt-card',
    title: 'Merge blocked (base moved)',
    description: 'The final fast-forward failed.',
    summary: 'Fast-forward failed',
    risk: 'low',
    policyRuleId: 'fast_forward_failure_escalation',
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    audit: [],
    fingerprint: 'fp',
    continuation: { kind: 'lane', laneId: 'lane-card', verb: 'merge' },
    ...extra,
  };
}

const render = (record: ApprovalRecord) => renderToStaticMarkup(createElement(O8ApprovalCards, {
  approvals: [record],
  busyApproval: null,
  noteById: {},
  onResolve: () => {},
}));

const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

describe('approval card referee row', () => {
  it('renders the advisory referee row beside the rule risk', () => {
    const markup = render(approval({ referee }));
    const visible = text(markup);

    expect(visible).toContain('Low risk');
    expect(markup).toContain('data-o8-referee-row');
    expect(visible).toContain('Referee');
    expect(visible).toContain('Advisory');
    expect(visible).toContain('Not used by the merge decision');
    expect(visible).toContain('jev-1.13.0');
    expect(visible).toContain('Docs only 3%');
    expect(visible).toContain('Adds tests 12%');
    expect(visible).toContain('Touches middleware or auth (o8 path check: yes) 91%');
    expect(visible).toContain('Placeholder or mock data 7%');
    expect(visible).toContain('Referee risk 3.1 of 4');
    expect(visible).toContain(DIFF_QUESTIONS.risk.criteria[3]);
    expect(visible).toContain('diff truncated · 2 files added from diff');
    expect(visible).not.toContain('hidden text found');
    // Record-only answers are never rendered.
    expect(visible).not.toMatch(/scope|entry point|recommended|autoApprove|operatorCard/i);
    // Inline styles and theme tokens only.
    expect(markup).not.toContain('class=');
    expect(markup).toContain('var(--t-input-bg)');
  });

  it('marks an abstained risk score', () => {
    const visible = text(render(approval({
      referee: { ...referee, answers: { ...referee.answers, risk: { ...referee.answers.risk, confidence: 0.2, abstain: true } } },
    })));
    expect(visible).toContain('Referee risk (low confidence, abstained) 3.1 of 4');
  });

  it('renders the card exactly as before when there is no referee', () => {
    const without = render(approval());
    expect(without).not.toContain('Referee');
    expect(without).not.toContain('data-o8-referee-row');
    expect(render(approval({ referee: undefined }))).toBe(without);
  });
});

describe('merge approval card', () => {
  it('puts the blocker and review action ahead of internal details and advisory scores', () => {
    const markup = render(approval({
      title: 'Review required before merge',
      description: 'This merge has no durable approval for the current worktree HEAD. The latest AI review does not authorize the current HEAD. Operator approval is required to continue.',
      policyRuleId: 'lane-merge',
      risk: 'high',
      metadata: { Packet: 'pkt-internal', Lane: 'lane-internal' },
      referee,
    }));
    const visible = text(markup);

    expect(visible).toContain('Merge paused: review these changes before approving.');
    expect(visible).toContain('No approved review is recorded for this exact revision.');
    expect(visible).toContain('Approve merge');
    expect(markup).toContain('<details');
    expect(markup).not.toContain('<details open');
    expect(markup.indexOf('No approved review')).toBeLessThan(markup.indexOf('<details'));
    expect(markup.indexOf('pkt-internal')).toBeGreaterThan(markup.indexOf('<details'));
    expect(markup.indexOf('data-o8-referee-row')).toBeGreaterThan(markup.indexOf('<details'));
  });
});
