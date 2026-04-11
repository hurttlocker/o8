import { memo, type CSSProperties, type ReactNode } from 'react';
import type { TopBarProps } from './types';
import { SpeedDialButton } from './SpeedDial';
import { useTheme } from './ThemeContext';

const fontFamily = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif";

// No backdrop, no fade, no overlay. Clean.

function MoreIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h.01M12 12h.01M19 12h.01" />
    </svg>
  );
}

function HeaderIconButton({
  label,
  onClick,
  children,
  style,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  style: CSSProperties;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      style={style}
    >
      {children}
    </button>
  );
}

function screenTitle(activeView: TopBarProps['activeView']) {
  switch (activeView) {
    case 'squad':
      return '';
    case 'fleet':
      return 'Agents';
    case 'activity':
      return 'Activity';
    case 'settings':
      return 'Settings';
    case 'issues':
      return 'Issues';
    case 'costs':
      return 'Costs';
    default:
      return 'Code';
  }
}

export const TopBar = memo(function TopBar({
  selectedSession,
  headerVisible,
  pendingApprovalsCount,
  activeView,
  compactLine,
  activeScreen,
  enabledViews,
  onNavigate,
  onNewChat,
  onOpenControls,
}: TopBarProps) {
  const { colors } = useTheme();
  void compactLine;

  if (activeView !== 'squad' && activeView !== 'chat') {
    return null;
  }

  const isThreadView = activeView === 'chat';
  const primaryText = colors.text;
  const chromeBackground = colors.surface;
  const chromeBorder = colors.surfaceBorder;
  const headerStyle: CSSProperties = {
    position: 'fixed',
    top: 'calc(env(safe-area-inset-top, 0px) + 8px)',
    left: '50%',
    width: 'min(calc(100dvw - 28px), 390px)',
    transform: headerVisible ? 'translate(-50%, 0)' : 'translate(-50%, -10px)',
    display: 'grid',
    gridTemplateColumns: '44px minmax(0, 1fr) 44px',
    alignItems: 'center',
    gap: 12,
    zIndex: 110,
    opacity: headerVisible ? 1 : 0,
    pointerEvents: headerVisible ? 'auto' : 'none',
    transition: 'opacity 220ms ease, transform 220ms ease',
    background: 'transparent',
  };
  const iconButtonStyle: CSSProperties = {
    width: 44,
    height: 44,
    minWidth: 44,
    minHeight: 44,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: `1px solid ${chromeBorder}`,
    borderRadius: 999,
    background: chromeBackground,
    color: primaryText,
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    boxShadow: '0 12px 28px rgba(0, 0, 0, 0.28)',
    cursor: 'pointer',
    padding: 0,
    outlineColor: colors.blueAccent,
    outlineOffset: 2,
    WebkitTapHighlightColor: 'transparent',
  };
  const copyStyle: CSSProperties = {
    minWidth: 0,
    textAlign: 'center',
  };
  const titleStyle: CSSProperties = {
    margin: 0,
    color: primaryText,
    fontFamily,
    fontSize: '1.06rem',
    fontWeight: 700,
    letterSpacing: '-0.025em',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };
  const spacerStyle: CSSProperties = {
    display: 'block',
    width: 44,
    height: 44,
    opacity: 0,
    pointerEvents: 'none',
  };

  return (
    <>
      {/* no backdrop overlay */}
      <header style={headerStyle}>
        {isThreadView ? (
          <HeaderIconButton
            label="Back"
            onClick={() => onNavigate('fleet')}
            style={iconButtonStyle}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
          </HeaderIconButton>
        ) : (
          <SpeedDialButton
            activeScreen={activeScreen}
            enabledViews={enabledViews}
            onNavigate={onNavigate}
            onNewChat={onNewChat}
            approvalCount={pendingApprovalsCount}
          />
        )}

        <div style={copyStyle}>
          <h1 style={titleStyle}>{isThreadView ? (selectedSession?.name ?? 'Chat') : screenTitle(activeView)}</h1>
          {isThreadView ? <p style={{ margin: 0, color: colors.textSecondary, fontSize: 12, fontFamily }}>Remote control</p> : null}
        </div>

        {isThreadView ? (
          <HeaderIconButton
            label="Open thread controls"
            onClick={onOpenControls}
            style={iconButtonStyle}
          >
            <MoreIcon />
          </HeaderIconButton>
        ) : (
          <span style={spacerStyle} aria-hidden="true" />
        )}
      </header>
    </>
  );
});
