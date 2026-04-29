'use client';

/**
 * /context-graph — Right column.
 *
 * Curated Context: the four artifacts the orchestrator emits before
 * (and during) a dispatch. Replaces Augment's product list (Completions,
 * Code Review, Agents, Intent) with the o8-native equivalents.
 */

import { SectionLabel, NumberedHeading, CuratedRow, FONT_SANS } from './shared';

export interface CuratedOutput {
  index: string;
  title: string;
  blurb: string;
}

export const CURATED_OUTPUTS: CuratedOutput[] = [
  {
    index: '01',
    title: 'Recall Card',
    blurb:
      'Top-of-packet brief. Three to five facts the orchestrator must not forget — pulled from directives, prior outcomes, and commits.',
  },
  {
    index: '02',
    title: 'Dispatch Context',
    blurb:
      'The full packet handed to the worker model. Files, symbols, and constraints scoped to the change — not the whole tree.',
  },
  {
    index: '03',
    title: 'Drift Detection',
    blurb:
      'Watches the worker session for divergence from the directives. Pauses the run before it touches a forbidden surface.',
  },
  {
    index: '04',
    title: 'Verdict & Concerns',
    blurb:
      'Pre-merge review. Flags rule violations, missing tests, and decisions that need a human before the diff lands.',
  },
];

export default function RightColumn() {
  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        flex: '0 0 280px',
      }}
      aria-labelledby="ctx-graph-right-heading"
    >
      <SectionLabel>CURATED CONTEXT</SectionLabel>
      <div id="ctx-graph-right-heading">
        <NumberedHeading index="03" title="Outputs" />
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
        What the orchestrator emits. Four artifacts, every dispatch.
      </p>

      <div style={{ marginTop: '8px' }}>
        {CURATED_OUTPUTS.map((row) => (
          <CuratedRow
            key={row.title}
            index={row.index}
            title={row.title}
            blurb={row.blurb}
          />
        ))}
      </div>
    </section>
  );
}
