'use client';

/**
 * OrgSuggestionStrip — soft auto-suggest card. Surfaces when 2+ repos share
 * a GitHub org and no project covers them. [Group] creates the project,
 * [Dismiss] writes to dismissed_suggestions so we never re-pitch the same
 * grouping.
 */

import { RamsButton } from '../shared';
import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_ACCENT,
  RAMS_HAIRLINE,
  type OrgSuggestion,
} from './shared';

export function OrgSuggestionStrip({
  suggestion,
  onGroup,
  onDismiss,
  busy,
}: {
  suggestion: OrgSuggestion;
  onGroup: () => void;
  onDismiss: () => void;
  busy: boolean;
}) {
  const repoNames = suggestion.repos.map((r) => r.name);
  const summary = repoNames.length === 2
    ? `${repoNames[0]} and ${repoNames[1]}`
    : `${repoNames.slice(0, -1).join(', ')}, and ${repoNames[repoNames.length - 1]}`;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        paddingTop: 14,
        paddingRight: 18,
        paddingBottom: 14,
        paddingLeft: 18,
        borderRadius: 4,
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: RAMS_HAIRLINE,
        background: 'transparent',
      }}
    >
      <span style={{
        fontFamily: MONO_FONT_STACK,
        fontSize: 9.5,
        fontWeight: 500,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        color: RAMS_ACCENT,
        flexShrink: 0,
      }}>
        (suggestion)
      </span>
      <span style={{
        flex: 1,
        fontFamily: APP_FONT_STACK,
        fontSize: 12.5,
        color: 'var(--t-text-secondary)',
        lineHeight: 1.5,
        letterSpacing: '-0.005em',
      }}>
        {summary} are both under{' '}
        <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 12, color: 'var(--t-text)' }}>{suggestion.org}</span>
        {' '}— group as a project?
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <RamsButton onClick={onGroup} busy={busy} disabled={busy}>Group</RamsButton>
        <RamsButton variant="ghost" onClick={onDismiss} disabled={busy}>Dismiss</RamsButton>
      </div>
    </div>
  );
}
