'use client';

/**
 * /context-graph — Left column.
 *
 * Realtime Raw Context: the actual data sources o8 reads on every dispatch.
 * Six rows, each with a label, a one-line detail, and a 4-dot intensity
 * indicator scaled to roughly how much weight that source carries when the
 * Recall Card is built (#742).
 */

import { SectionLabel, NumberedHeading, SourceRow, FONT_SANS } from './shared';

export interface LeftColumnSource {
  label: string;
  detail: string;
  intensity: number;
}

export const LEFT_COLUMN_SOURCES: LeftColumnSource[] = [
  {
    label: 'Files',
    detail: 'Codebase scan — every tracked source, scoped to the active repo',
    intensity: 4,
  },
  {
    label: 'Symbols',
    detail: 'Tree-sitter index from codebase-memory-mcp (~/.o8/codebase-memory)',
    intensity: 4,
  },
  {
    label: 'Directives',
    detail: '~/.o8/directives/*.md — explicit team rules the orchestrator must honor',
    intensity: 3,
  },
  {
    label: 'Outcomes',
    detail: 'session_outcomes ledger — every prior dispatch graded against its packet',
    intensity: 3,
  },
  {
    label: 'Recent commits',
    detail: 'git log on every active worktree — scoped to the last 24 hours',
    intensity: 2,
  },
  {
    label: 'Issues',
    detail: 'GitHub issues for the active repo, ranked by relevance to the brief',
    intensity: 2,
  },
];

export default function LeftColumn() {
  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        flex: '0 0 280px',
      }}
      aria-labelledby="ctx-graph-left-heading"
    >
      <SectionLabel>REALTIME RAW CONTEXT</SectionLabel>
      <div id="ctx-graph-left-heading">
        <NumberedHeading index="01" title="Sources" />
      </div>
      <p
        style={{
          fontFamily: FONT_SANS,
          fontSize: '12.5px',
          fontWeight: 400,
          color: 'var(--t-text-secondary)',
          lineHeight: 1.55,
          letterSpacing: '-0.005em',
          marginTop: '6px',
          marginBottom: '6px',
          maxWidth: '260px',
        }}
      >
        What we read on every dispatch. No vector index, no hosted store.
      </p>

      <div style={{ marginTop: '8px' }}>
        {LEFT_COLUMN_SOURCES.map((source) => (
          <SourceRow
            key={source.label}
            label={source.label}
            detail={source.detail}
            intensity={source.intensity}
          />
        ))}
      </div>
    </section>
  );
}
