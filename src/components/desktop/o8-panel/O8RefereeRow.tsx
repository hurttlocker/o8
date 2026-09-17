'use client';

import type { ApprovalReferee } from '@/lib/approvals/types';

/**
 * Advisory referee row on an approval card (#2435). Renders the card-visible
 * answers as probabilities and the risk score with its legend. The card's
 * Risk pill stays the rule risk; nothing here feeds a decision.
 */

const MONO_FONT = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)';

const NOUL_LABELS: Array<[keyof Omit<ApprovalReferee['answers'], 'risk'>, string]> = [
  ['docsOnly', 'Docs only'],
  ['addsTests', 'Adds tests'],
  ['touchesMiddlewareOrAuth', 'Touches middleware or auth'],
  ['containsPlaceholderOrMockData', 'Placeholder or mock data'],
];

const percent = (value: number) => `${Math.round(value * 100)}%`;

function riskLevels(referee: ApprovalReferee): number {
  return Math.max(2, Object.keys(referee.answers.risk.legend).length);
}

function riskLegend(referee: ApprovalReferee): string {
  const { score, legend } = referee.answers.risk;
  const level = Math.min(riskLevels(referee) - 1, Math.max(0, Math.round(score)));
  return legend[String(level)] ?? '';
}

function flagLabels(referee: ApprovalReferee): string[] {
  const flags: string[] = [];
  if (referee.truncated) flags.push('diff truncated');
  if (referee.hiddenText) flags.push('hidden text found');
  if (referee.filesAddedFromDiff > 0) {
    flags.push(`${referee.filesAddedFromDiff} file${referee.filesAddedFromDiff === 1 ? '' : 's'} added from diff`);
  }
  return flags;
}

function AnswerLine({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
      <span style={{ flex: 1, minWidth: 0, fontSize: 10.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text-muted)', overflowWrap: 'anywhere' }}>
        {label}
        {note ? <span style={{ color: 'var(--t-text-faint)' }}>{` (${note})`}</span> : null}
      </span>
      <span style={{ fontFamily: MONO_FONT, fontSize: 10.5, fontWeight: 300, letterSpacing: '-0.2px', color: 'var(--t-text-secondary)', whiteSpace: 'nowrap' }}>
        {value}
      </span>
    </div>
  );
}

export function O8RefereeRow({ referee }: { referee: ApprovalReferee }) {
  const { risk } = referee.answers;
  const flags = flagLabels(referee);
  return (
    <div
      data-o8-referee-row=""
      style={{ display: 'grid', gridTemplateColumns: '68px minmax(0, 1fr)', gap: 8, alignItems: 'baseline', marginBottom: 7 }}
    >
      <span style={{ fontSize: 9, fontWeight: 300, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--t-text-faint)' }}>
        Referee
      </span>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
          minWidth: 0,
          paddingTop: 6,
          paddingRight: 8,
          paddingBottom: 6,
          paddingLeft: 8,
          borderRadius: 6,
          border: '1px solid var(--t-divider-subtle)',
          background: 'var(--t-input-bg)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap', marginBottom: 2 }}>
          <span style={{ fontSize: 9, fontWeight: 400, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--t-text-faint)' }}>
            Advisory
          </span>
          <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '-0.2px', color: 'var(--t-text-faint)' }}>
            Not used by the merge decision
          </span>
          <span style={{ fontFamily: MONO_FONT, fontSize: 9.5, fontWeight: 300, letterSpacing: '-0.2px', color: 'var(--t-text-faint)', overflowWrap: 'anywhere' }}>
            {referee.model}
          </span>
        </div>
        {NOUL_LABELS.map(([key, label]) => (
          <AnswerLine
            key={key}
            label={label}
            value={percent(referee.answers[key].noul)}
            note={key === 'touchesMiddlewareOrAuth' ? `o8 path check: ${referee.pathTouchesMiddlewareOrAuth ? 'yes' : 'no'}` : undefined}
          />
        ))}
        <AnswerLine
          label="Referee risk"
          value={`${risk.score.toFixed(1)} of ${riskLevels(referee) - 1}`}
          note={risk.abstain ? 'low confidence, abstained' : undefined}
        />
        <div style={{ fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.2px', lineHeight: 1.3, color: 'var(--t-text-faint)', overflowWrap: 'anywhere' }}>
          {riskLegend(referee)}
        </div>
        {flags.length > 0 ? (
          <div style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '-0.2px', color: 'var(--t-text-faint)', overflowWrap: 'anywhere' }}>
            {flags.join(' · ')}
          </div>
        ) : null}
      </div>
    </div>
  );
}
