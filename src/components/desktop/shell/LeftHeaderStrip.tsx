'use client';

/**
 * LeftHeaderStrip — header strip for the left (nav / AgentPanel) column.
 * Hosts the macOS traffic-light inset and the sidebar toggle. Part of epic #1089.
 */

import { ColumnHeaderStrip } from './ColumnHeaderStrip';
import { IconPanelLeft } from '../title-bar/icons';

interface LeftHeaderStripProps {
  sidebarVisible?: boolean;
  onToggleSidebar?: () => void;
}

/**
 * Flat icon button — no chrome-btn background or boxed active state. Sits over
 * the solid panel card (post epic #1089 floating-card refactor) where the
 * boxed TitleBarButton active state read as a heavy outline against the paper.
 * Active = icon color only; rest = muted; hover = subtle bg tint.
 */
function FlatIconButton({
  icon,
  label,
  title,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  title?: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        // Sized to baseline-match the macOS traffic lights (~13px). The 18px
        // button area gives just enough hit target without dwarfing the dots.
        width: 18,
        height: 18,
        padding: 0,
        border: 'none',
        borderRadius: 4,
        background: 'transparent',
        color: active ? 'var(--t-text)' : 'var(--t-text-secondary)',
        cursor: 'pointer',
        flexShrink: 0,
        WebkitTapHighlightColor: 'transparent',
        ['WebkitAppRegion' as string]: 'no-drag',
        transition: 'background 120ms ease, color 120ms ease',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--t-hover)';
        e.currentTarget.style.color = 'var(--t-text)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.color = active ? 'var(--t-text)' : 'var(--t-text-secondary)';
      }}
    >
      {icon}
    </button>
  );
}

export function LeftHeaderStrip({ sidebarVisible = true, onToggleSidebar }: LeftHeaderStripProps) {
  return (
    <ColumnHeaderStrip
      drag
      // Tighter than the default 36px strip — the macOS traffic lights are
      // ~13px tall centered at y~16. With a 28px strip the toggle button
      // (18px) centers at y~18, much closer to the lights' baseline.
      height={28}
      left={
        <>
          {/* Spacer for the macOS traffic lights (close / minimize / maximize).
              Lights are drawn by the OS at window-x ~8–62. With the panel
              card's 5px paddingLeft + the strip's 8px paddingLeft, the strip
              content starts at window-x = 5 + 8 = 13. Spacer clears x=62 plus
              ~12px breathing room so the toggle sits a hair right of the
              green light, not crammed against it. */}
          <div style={{ width: 64, flexShrink: 0 }} />
          <FlatIconButton
            icon={<IconPanelLeft size={13} />}
            label="Toggle sidebar"
            title="Toggle sidebar (⌘B)"
            onClick={onToggleSidebar}
            active={sidebarVisible}
          />
        </>
      }
    />
  );
}
