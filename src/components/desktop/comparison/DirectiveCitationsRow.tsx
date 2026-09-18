'use client';

import { DIRECTIVE_CITATIONS_LABEL, type DirectiveCitationsPreview } from '@/lib/judgment/directive-citations-format';

/**
 * Advisory rule citations on the merge preview (#2446): each cited rule quoted
 * verbatim, with the file, the probability, and the receipt id. Same geometry
 * as the referee row on the approval card (#2435). Nothing here feeds the gate.
 */

const MONO_FONT = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)';

export function DirectiveCitationsRow({ preview }: { preview: DirectiveCitationsPreview | undefined }) {
  if (!preview || preview.status === 'off') return null;
  return (
    <div
      data-o8-directive-citations-row=""
      style={{ display: 'grid', gridTemplateColumns: '68px minmax(0, 1fr)', gap: 8, alignItems: 'baseline', marginTop: 4 }}
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
        <span style={{ fontSize: 9, fontWeight: 400, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--t-text-faint)', marginBottom: 2 }}>
          {DIRECTIVE_CITATIONS_LABEL}
        </span>
        {preview.status === 'pending' ? (
          <span style={{ fontSize: 10.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text-faint)' }}>
            Checking the changed files against the repo rules…
          </span>
        ) : preview.citations.length === 0 ? (
          <span style={{ fontSize: 10.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text-faint)' }}>
            No rule cited
          </span>
        ) : preview.citations.map((citation) => (
          <div key={`${citation.path}:${citation.ruleId}`} style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
            <span style={{ fontSize: 10.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text-muted)', overflowWrap: 'anywhere' }}>
              &ldquo;{citation.ruleText}&rdquo;
            </span>
            <span style={{ fontFamily: MONO_FONT, fontSize: 9.5, fontWeight: 300, letterSpacing: '-0.2px', color: 'var(--t-text-faint)', overflowWrap: 'anywhere' }}>
              {citation.path} · {citation.probability.toFixed(2)} · {citation.receiptId ?? 'no receipt'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
