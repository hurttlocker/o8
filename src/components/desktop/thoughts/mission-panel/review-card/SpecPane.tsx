'use client';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import {
  DirectiveSummary,
  FONT_FAMILY,
  PANE_BORDER_COLOR,
  paneLabelStyle,
  paneStyle,
} from './shared';

/**
 * #729 — SPEC pane: issue title/body + directives invoked.
 */
export function SpecPane({ packet, directives, directivesError }: {
  packet: OrchestratorPacket;
  directives: DirectiveSummary[] | null;
  directivesError: string | null;
}) {
  const issueBody = packet.issue?.body?.trim() ?? '';
  const issueNumber = packet.issue?.number ?? null;
  const issueUrl = packet.issue?.url ?? null;

  return (
    <div style={paneStyle()}>
      <div style={paneLabelStyle()}>SPEC</div>
      <div style={{
        fontSize: 12.5,
        fontWeight: 700,
        color: 'var(--t-text)',
        letterSpacing: '-0.01em',
        lineHeight: 1.35,
        fontFamily: FONT_FAMILY,
      }}>
        {issueNumber ? `#${issueNumber} — ` : ''}{packet.title}
      </div>
      {issueUrl ? (
        <a
          href={issueUrl}
          target="_blank"
          rel="noreferrer"
          style={{
            fontSize: 10.5,
            color: '#2563eb',
            textDecoration: 'none',
            fontFamily: FONT_FAMILY,
            wordBreak: 'break-all',
          }}
        >
          {issueUrl}
        </a>
      ) : null}
      {issueBody ? (
        <div style={{
          fontSize: 11,
          color: 'var(--t-text-secondary)',
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          fontFamily: FONT_FAMILY,
          paddingTop: 4,
          paddingBottom: 4,
          maxHeight: 160,
          overflowY: 'auto',
          borderTopWidth: 1,
          borderTopStyle: 'solid',
          borderTopColor: PANE_BORDER_COLOR,
          borderBottomWidth: 1,
          borderBottomStyle: 'solid',
          borderBottomColor: PANE_BORDER_COLOR,
        }}>
          {issueBody}
        </div>
      ) : packet.summary ? (
        <div style={{
          fontSize: 11,
          color: 'var(--t-text-secondary)',
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          fontFamily: FONT_FAMILY,
        }}>
          {packet.summary}
        </div>
      ) : null}

      <div style={{ ...paneLabelStyle(), paddingTop: 6 }}>Directives invoked</div>
      {directivesError ? (
        <div style={{ fontSize: 10.5, color: '#b91c1c', fontFamily: FONT_FAMILY }}>
          {directivesError}
        </div>
      ) : !directives ? (
        <div style={{ fontSize: 10.5, color: 'var(--t-text-muted)', fontFamily: FONT_FAMILY }}>
          Loading directives…
        </div>
      ) : directives.length === 0 ? (
        <div style={{ fontSize: 10.5, color: 'var(--t-text-muted)', fontFamily: FONT_FAMILY }}>
          No directives configured.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {directives.map((directive) => (
            <div
              key={directive.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                paddingTop: 5,
                paddingRight: 7,
                paddingBottom: 5,
                paddingLeft: 7,
                borderRadius: 8,
                background: 'rgba(148, 163, 184, 0.08)',
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'rgba(148, 163, 184, 0.16)',
              }}
            >
              <span style={{
                flexShrink: 0,
                fontSize: 9,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                color: directive.scope === 'global' ? '#2563eb' : 'var(--t-text-muted)',
                paddingTop: 2,
                fontFamily: FONT_FAMILY,
              }}>
                {directive.scope}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--t-text)',
                  fontFamily: FONT_FAMILY,
                  lineHeight: 1.35,
                }}>
                  {directive.title}
                </div>
                {directive.body ? (
                  <div style={{
                    fontSize: 10,
                    color: 'var(--t-text-muted)',
                    fontFamily: FONT_FAMILY,
                    lineHeight: 1.4,
                    marginTop: 2,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                  } as React.CSSProperties}>
                    {directive.body}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
