'use client';

/**
 * #915 sub-4 — Streaming answer renderer for Ask Anything.
 *
 * Takes the running token buffer + accumulated citations and renders them
 * inline. Citation markers in the token text use the form
 *   `[CITATION:<rowId>]`
 * and get replaced with a <CitationPill> component at render time. The
 * sub-2 wave will swap the marker grammar once the real composer settles.
 *
 * Optional contradiction footer renders when the stream has emitted a
 * `contradiction` event — surfaces the directive ↔ outcome conflict so the
 * operator can resolve in the directive sheet later.
 */

import { Fragment, type ReactNode } from 'react';
import { CitationPill, type Citation } from './CitationPill';
import { FONT_FAMILY } from './shared';

export interface ContradictionNote {
  directiveId: string;
  outcomeId: string;
  summary: string;
}

interface AnswerStreamProps {
  tokens: string;
  citations: Citation[];
  contradiction?: ContradictionNote | null;
  /** When true, a typing indicator dot is appended to the tail. */
  streaming: boolean;
  onCitationClick?: (citation: Citation) => void;
}

const CITATION_MARKER = /\[CITATION:([a-zA-Z0-9_\-#.]+)\]/g;

function buildCitationMap(citations: Citation[]): Map<string, Citation> {
  const map = new Map<string, Citation>();
  for (const c of citations) {
    map.set(c.rowId, c);
    // Also key on the raw label form (`D-014`) and the bare numeric id
    // so the marker grammar can be flexible during the scaffold.
    map.set(c.rowId.toUpperCase(), c);
  }
  return map;
}

function renderTokensWithCitations(
  tokens: string,
  citations: Citation[],
  onCitationClick?: (citation: Citation) => void,
): ReactNode[] {
  const map = buildCitationMap(citations);
  const out: ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  // Reset regex state so repeat renders are stable.
  CITATION_MARKER.lastIndex = 0;
  let match: RegExpExecArray | null = null;
  while ((match = CITATION_MARKER.exec(tokens)) !== null) {
    const start = match.index;
    if (start > cursor) {
      out.push(<Fragment key={`t-${key++}`}>{tokens.slice(cursor, start)}</Fragment>);
    }
    const id = match[1];
    const citation =
      map.get(id) ?? map.get(id.toUpperCase()) ?? null;
    if (citation) {
      out.push(
        <CitationPill
          key={`c-${key++}-${id}`}
          citation={citation}
          onClick={onCitationClick}
        />,
      );
    } else {
      // Unmatched marker — keep the raw text rather than disappear it,
      // so the operator sees the citation hole.
      out.push(<Fragment key={`u-${key++}`}>{match[0]}</Fragment>);
    }
    cursor = start + match[0].length;
  }
  if (cursor < tokens.length) {
    out.push(<Fragment key={`t-${key++}`}>{tokens.slice(cursor)}</Fragment>);
  }
  return out;
}

export function AnswerStream({
  tokens,
  citations,
  contradiction,
  streaming,
  onCitationClick,
}: AnswerStreamProps) {
  const isEmpty = tokens.length === 0 && !streaming;
  if (isEmpty && !contradiction) return null;

  const nodes = renderTokensWithCitations(tokens, citations, onCitationClick);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        paddingTop: 6,
        paddingRight: 10,
        paddingBottom: 8,
        paddingLeft: 102,
      }}
    >
      <div
        style={{
          fontFamily: FONT_FAMILY,
          fontSize: 11.5,
          lineHeight: 1.55,
          color: 'var(--t-text)',
          letterSpacing: '-0.005em',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {nodes}
        {streaming ? (
          <span
            aria-hidden
            style={{
              display: 'inline-block',
              marginLeft: 3,
              width: 6,
              height: 12,
              verticalAlign: 'text-bottom',
              background: 'var(--t-text-faint)',
              opacity: 0.7,
              animationName: 'o8AskBlink',
              animationDuration: '900ms',
              animationIterationCount: 'infinite',
              animationTimingFunction: 'ease-in-out',
            }}
          />
        ) : null}
      </div>
      {contradiction ? <ContradictionFooter note={contradiction} /> : null}
      <style>{`
        @keyframes o8AskBlink {
          0%, 100% { opacity: 0.15; }
          50% { opacity: 0.7; }
        }
      `}</style>
    </div>
  );
}

function ContradictionFooter({ note }: { note: ContradictionNote }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        paddingTop: 6,
        paddingRight: 10,
        paddingBottom: 6,
        paddingLeft: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'rgba(245, 158, 11, 0.35)',
        background: 'rgba(245, 158, 11, 0.08)',
      }}
    >
      <span
        style={{
          fontFamily: FONT_FAMILY,
          fontSize: 9.5,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: '#b45309',
          flexShrink: 0,
          marginTop: 1,
        }}
      >
        Conflict noted
      </span>
      <span
        style={{
          fontFamily: FONT_FAMILY,
          fontSize: 11,
          lineHeight: 1.5,
          color: 'var(--t-text)',
          letterSpacing: '-0.005em',
        }}
      >
        {note.summary}
        <span
          style={{
            color: 'var(--t-text-faint)',
            marginLeft: 6,
            fontSize: 10,
          }}
        >
          {note.directiveId} ↔ {note.outcomeId}
        </span>
      </span>
    </div>
  );
}
