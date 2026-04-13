'use client';

import { ChevronRight, Globe } from '../lucide-shims';
import { CopyCommand } from './atoms';
import {
  THEME_ACCENT,
  THEME_GLASS_MUTED_STRONG,
  THEME_PANEL_BORDER,
  THEME_TEXT,
  THEME_TEXT_MUTED,
  THEME_TEXT_SECONDARY,
} from './theme';
import type { MissingToolAction } from './types';

export function MissingToolCard({
  action,
  onSkip,
}: {
  action: MissingToolAction;
  onSkip: () => void;
}) {
  return (
    <div style={{
      padding: '14px 16px',
      borderRadius: 14,
      background: THEME_GLASS_MUTED_STRONG,
      border: `1px solid ${THEME_PANEL_BORDER}`,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: THEME_ACCENT }}>{action.icon}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: THEME_TEXT }}>{action.name}</span>
        <button
          onClick={onSkip}
          style={{
            marginLeft: 'auto',
            fontSize: 11,
            fontWeight: 600,
            color: THEME_TEXT_MUTED,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          Skip
        </button>
      </div>
      <div style={{ fontSize: 12, color: THEME_TEXT_SECONDARY, lineHeight: 1.5 }}>
        {action.description}
      </div>
      {action.command && <CopyCommand command={action.command} />}
      {action.link && (
        <a
          href={action.link}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: THEME_ACCENT,
            textDecoration: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <Globe size={12} strokeWidth={2} />
          {action.link.replace('https://', '')}
          <ChevronRight size={12} strokeWidth={2} />
        </a>
      )}
    </div>
  );
}
