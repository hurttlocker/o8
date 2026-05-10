'use client';

/**
 * #915 sub-4 — Inline citation pill for the Ask Anything answer stream.
 *
 * Renders as a bracketed monospace chip — `[KIND-ID]` — wired into the
 * streaming answer between tokens. Click opens the source row (URL or
 * local navigate target). Hover shows the excerpt as a native tooltip.
 *
 * The renderer keeps a minimal frontend citation shape while reusing the
 * canonical Cortex Q&A citation kind union.
 */

import type { CitationKind as CanonicalCitationKind } from '@/lib/cortex/qa/types';
import { MONO_FAMILY } from './shared';

export type CitationKind = CanonicalCitationKind;

export interface Citation {
  kind: CitationKind;
  rowId: string;
  excerpt: string;
  url?: string | null;
}

interface CitationPillProps {
  citation: Citation;
  /** Optional click override — defaults to opening URL or no-op log. */
  onClick?: (citation: Citation) => void;
}

const KIND_LABEL: Record<CitationKind, string> = {
  directive: 'D',
  outcome: 'O',
  pr: 'PR',
  issue: 'I',
  comment: 'CMT',
  doc: 'DOC',
  fact: 'FACT',
  symbol: 'S',
  project: 'PROJ',
  project_repo: 'PRJREPO',
};

export function citationLabel(citation: Citation): string {
  // Row IDs may already contain the kind prefix (e.g. "D-014") — keep
  // them as-is so the bracketed chip reads `[D-014]` not `[D-D-014]`.
  const id = citation.rowId.trim();
  const canonicalPrefix = `${citation.kind}-`;
  const displayId = id.toLowerCase().startsWith(canonicalPrefix)
    ? id.slice(canonicalPrefix.length)
    : id;
  const kindPrefix = `${KIND_LABEL[citation.kind]}-`;
  if (displayId.toUpperCase().startsWith(kindPrefix)) {
    return `[${displayId.toUpperCase()}]`;
  }
  return `[${KIND_LABEL[citation.kind]}-${displayId}]`;
}

export function CitationPill({ citation, onClick }: CitationPillProps) {
  const handle = () => {
    if (onClick) {
      onClick(citation);
      return;
    }
    if (citation.url && typeof window !== 'undefined') {
      window.open(citation.url, '_blank', 'noopener,noreferrer');
      return;
    }
    // Wave B wires real navigation — log for now so demo flow is observable.
    console.log('[ask-anything] citation click', citation);
  };

  return (
    <button
      type="button"
      onClick={handle}
      title={citation.excerpt}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        verticalAlign: 'baseline',
        marginLeft: 3,
        marginRight: 3,
        paddingTop: 1,
        paddingRight: 5,
        paddingBottom: 1,
        paddingLeft: 5,
        borderRadius: 6,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider-subtle)',
        background: 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))',
        color: 'var(--t-accent, #2563eb)',
        cursor: 'pointer',
        fontFamily: MONO_FAMILY,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: '0.02em',
        lineHeight: 1.2,
      }}
    >
      {citationLabel(citation)}
    </button>
  );
}
